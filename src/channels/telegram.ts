import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { processImage } from '../image.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { transcribeWithWhisperCpp } from '../transcription.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const TG_GETFILE_MAX_BYTES = 20 * 1024 * 1024;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/** Download a file from the Telegram Bot API into a Buffer. */
function downloadTelegramFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Telegram file download failed: ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, '_').slice(0, 120);
  return cleaned || `file-${Date.now()}`;
}

/**
 * Resolve a Telegram file_id to bytes on disk in the group's attachments dir.
 * Returns null when the file exceeds the Bot API getFile cap or download fails.
 */
async function fetchTelegramAttachment(opts: {
  api: Api;
  botToken: string;
  fileId: string;
  fileSize?: number;
  preferredName?: string;
  fallbackExt: string;
  groupDir: string;
}): Promise<{
  absPath: string;
  relPath: string;
  filename: string;
  bytes: number;
} | null> {
  const { api, botToken, fileId, fileSize, preferredName, fallbackExt, groupDir } =
    opts;
  if (fileSize !== undefined && fileSize > TG_GETFILE_MAX_BYTES) return null;
  const file = await api.getFile(fileId);
  if (!file.file_path) return null;
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const buffer = await downloadTelegramFile(url);

  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const baseName = preferredName
    ? safeFilename(path.basename(preferredName))
    : `tg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${fallbackExt}`;
  const finalName = fs.existsSync(path.join(attachDir, baseName))
    ? `${Date.now()}-${baseName}`
    : baseName;
  const absPath = path.join(attachDir, finalName);
  fs.writeFileSync(absPath, buffer);
  return {
    absPath,
    relPath: `attachments/${finalName}`,
    filename: finalName,
    bytes: buffer.length,
  };
}

// Bot pool for agent teams: send-only Api instances (no polling)
// Each bot is permanently named via BotFather — no runtime renaming.
const poolApis: Api[] = [];
// Maps bot display name (from BotFather) → pool index
const botNameIndex = new Map<string, number>();

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      const idx = poolApis.length;
      poolApis.push(api);
      // Index by the bot's display name (set via BotFather) for sender matching
      if (me.first_name) {
        botNameIndex.set(me.first_name.toLowerCase(), idx);
      }
      logger.info(
        {
          username: me.username,
          name: me.first_name,
          id: me.id,
          poolSize: poolApis.length,
        },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot matched by sender name.
 * Matches sender to the bot whose BotFather name matches (case-insensitive,
 * ignoring emoji). Falls back to round-robin if no match found.
 */
let nextPoolIndex = 0;
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot send
    return;
  }

  // Match sender name to bot name — strip emoji and extra whitespace
  const senderClean = sender
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .trim()
    .toLowerCase();
  let idx = botNameIndex.get(senderClean);
  if (idx === undefined) {
    // Fallback: round-robin for unknown senders
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    logger.info(
      { sender, senderClean, groupFolder, poolIndex: idx },
      'No matching pool bot, using round-robin',
    );
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // Common helper to deliver an attachment-derived message.
    const deliverAttachment = (
      ctx: any,
      content: string,
    ): void => {
      const chatJid = `tg:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const photos = ctx.message.photo;
      const captionText = ctx.message.caption ?? '';
      const captionTrail = captionText ? ` ${captionText}` : '';
      let content = `[Photo]${captionTrail}`;
      if (!photos || photos.length === 0) {
        deliverAttachment(ctx, content);
        return;
      }
      const largest = photos[photos.length - 1];

      try {
        if (
          largest.file_size !== undefined &&
          largest.file_size > TG_GETFILE_MAX_BYTES
        ) {
          content = `[Photo: too large to download (${Math.round(
            largest.file_size / 1024,
          )}KB)]${captionTrail}`;
        } else {
          const file = await ctx.api.getFile(largest.file_id);
          if (file.file_path) {
            const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
            const buffer = await downloadTelegramFile(url);
            const groupDir = path.join(GROUPS_DIR, group.folder);
            const result = await processImage(buffer, groupDir, captionText);
            if (result) {
              content = result.content;
              logger.info(
                { chatJid, relPath: result.relativePath },
                'Processed Telegram photo',
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Telegram photo download failed');
      }

      deliverAttachment(ctx, content);
    });

    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const doc = ctx.message.document;
      const captionText = ctx.message.caption ?? '';
      const captionTrail = captionText ? ` ${captionText}` : '';
      const mime = doc?.mime_type || 'application/octet-stream';
      const declaredName = doc?.file_name || 'file';
      if (!doc?.file_id) {
        deliverAttachment(ctx, `[Document: ${declaredName}]${captionTrail}`);
        return;
      }

      // Photos sent as documents (uncompressed) — route to image pipeline.
      if (
        mime.startsWith('image/') &&
        doc?.file_size !== undefined &&
        doc.file_size <= TG_GETFILE_MAX_BYTES
      ) {
        try {
          const file = await ctx.api.getFile(doc.file_id);
          if (file.file_path) {
            const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
            const buffer = await downloadTelegramFile(url);
            const groupDir = path.join(GROUPS_DIR, group.folder);
            const result = await processImage(buffer, groupDir, captionText);
            if (result) {
              deliverAttachment(ctx, result.content);
              logger.info(
                { chatJid, relPath: result.relativePath },
                'Processed Telegram document-image',
              );
              return;
            }
          }
        } catch (err) {
          logger.error(
            { err, chatJid },
            'Telegram document-image processing failed; falling through to raw save',
          );
        }
      }

      let content = `[Document: ${declaredName}]${captionTrail}`;
      try {
        const fallbackExt =
          declaredName.includes('.') && !declaredName.endsWith('.')
            ? declaredName.split('.').pop()!
            : 'bin';
        const saved = await fetchTelegramAttachment({
          api: ctx.api,
          botToken: this.botToken,
          fileId: doc!.file_id,
          fileSize: doc?.file_size,
          preferredName: declaredName,
          fallbackExt,
          groupDir: path.join(GROUPS_DIR, group.folder),
        });

        if (!saved) {
          const sizeKB =
            doc?.file_size !== undefined
              ? `${Math.round(doc.file_size / 1024)}KB`
              : 'unknown size';
          content = `[Document: ${declaredName} too large to download (${sizeKB})]${captionTrail}`;
        } else if (mime === 'application/pdf') {
          const sizeKB = Math.round(saved.bytes / 1024);
          const pdfRef = `[PDF: ${saved.relPath} (${sizeKB}KB)]\nUse: pdf-reader extract ${saved.relPath}`;
          content = captionText ? `${captionText}\n\n${pdfRef}` : pdfRef;
          logger.info(
            { chatJid, relPath: saved.relPath },
            'Downloaded Telegram PDF',
          );
        } else {
          content = `[Document: ${saved.relPath} mime=${mime}]${captionTrail}`;
          logger.info(
            { chatJid, relPath: saved.relPath, mime },
            'Downloaded Telegram document',
          );
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Telegram document download failed');
      }

      deliverAttachment(ctx, content);
    });

    this.bot.on('message:video', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const video = ctx.message.video;
      const captionText = ctx.message.caption ?? '';
      const captionTrail = captionText ? ` ${captionText}` : '';
      let content = `[Video]${captionTrail}`;
      if (!video?.file_id) {
        deliverAttachment(ctx, content);
        return;
      }

      try {
        const saved = await fetchTelegramAttachment({
          api: ctx.api,
          botToken: this.botToken,
          fileId: video!.file_id,
          fileSize: video?.file_size,
          preferredName: video?.file_name,
          fallbackExt: 'mp4',
          groupDir: path.join(GROUPS_DIR, group.folder),
        });
        if (!saved) {
          const sizeKB =
            video?.file_size !== undefined
              ? `${Math.round(video.file_size / 1024)}KB`
              : 'unknown size';
          content = `[Video: too large to download (${sizeKB})]${captionTrail}`;
        } else {
          const sizeKB = Math.round(saved.bytes / 1024);
          content = `[Video: ${saved.relPath} (${sizeKB}KB, ${video?.duration ?? '?'}s)]${captionTrail}`;
          logger.info(
            { chatJid, relPath: saved.relPath },
            'Downloaded Telegram video',
          );
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Telegram video download failed');
      }

      deliverAttachment(ctx, content);
    });

    this.bot.on('message:video_note', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const note = ctx.message.video_note;
      let content = `[Video note]`;
      if (!note?.file_id) {
        deliverAttachment(ctx, content);
        return;
      }

      try {
        const saved = await fetchTelegramAttachment({
          api: ctx.api,
          botToken: this.botToken,
          fileId: note!.file_id,
          fileSize: note?.file_size,
          preferredName: undefined,
          fallbackExt: 'mp4',
          groupDir: path.join(GROUPS_DIR, group.folder),
        });
        if (!saved) {
          content = `[Video note: too large to download]`;
        } else {
          content = `[Video note: ${saved.relPath} (${note?.duration ?? '?'}s)]`;
          logger.info(
            { chatJid, relPath: saved.relPath },
            'Downloaded Telegram video note',
          );
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Telegram video_note download failed');
      }

      deliverAttachment(ctx, content);
    });

    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice Message - transcription unavailable]';
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const buffer = await downloadTelegramFile(url);
        logger.info(
          { chatJid, bytes: buffer.length },
          'Downloaded Telegram voice message',
        );
        const transcript = await transcribeWithWhisperCpp(buffer);
        if (transcript) {
          content = `[Voice: ${transcript}]${caption}`;
          logger.info(
            { chatJid, length: transcript.length },
            'Transcribed Telegram voice message',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Telegram voice transcription error');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const audio = ctx.message.audio;
      const captionText = ctx.message.caption ?? '';
      const captionTrail = captionText ? ` ${captionText}` : '';
      let content = `[Audio]${captionTrail}`;
      if (!audio?.file_id) {
        deliverAttachment(ctx, content);
        return;
      }

      try {
        const saved = await fetchTelegramAttachment({
          api: ctx.api,
          botToken: this.botToken,
          fileId: audio!.file_id,
          fileSize: audio?.file_size,
          preferredName: audio?.file_name,
          fallbackExt: 'mp3',
          groupDir: path.join(GROUPS_DIR, group.folder),
        });

        if (!saved) {
          const sizeKB =
            audio?.file_size !== undefined
              ? `${Math.round(audio.file_size / 1024)}KB`
              : 'unknown size';
          content = `[Audio: too large to download (${sizeKB})]${captionTrail}`;
        } else {
          const buffer = fs.readFileSync(saved.absPath);
          const transcript = await transcribeWithWhisperCpp(buffer);
          if (transcript) {
            content = `[Audio: ${saved.relPath}] [Transcript: ${transcript}]${captionTrail}`;
            logger.info(
              { chatJid, length: transcript.length },
              'Transcribed Telegram audio',
            );
          } else {
            content = `[Audio: ${saved.relPath} (${audio?.duration ?? '?'}s) — transcription unavailable]${captionTrail}`;
          }
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Telegram audio handling failed');
      }

      deliverAttachment(ctx, content);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
