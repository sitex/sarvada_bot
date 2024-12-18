import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { createClient } from "@deepgram/sdk";
import crypto from 'crypto';

console.log('Starting bot initialization...');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB in bytes (Telegram's limit)

if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in the environment variables');
}

if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is not set in the environment variables');
}

console.log('TELEGRAM_BOT_TOKEN:', TELEGRAM_BOT_TOKEN ? 'Set' : 'Not set');
console.log('DEEPGRAM_API_KEY:', DEEPGRAM_API_KEY ? 'Set' : 'Not set');

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const deepgramClient = createClient(DEEPGRAM_API_KEY);

// Function to verify Telegram webhook
function verifyTelegramWebhook(req) {
    console.log('Verifying webhook...');
    console.log('Request method:', req.method);
    console.log('Request headers:', JSON.stringify(req.headers, null, 2));

    if (req.method !== 'POST') {
        console.log('Webhook verification failed: Not a POST request');
        return false;
    }

    const signatureHeader = req.headers['x-telegram-bot-api-secret-token'];
    console.log('Received secret token:', signatureHeader);

    if (!signatureHeader) {
        console.log('Webhook verification failed: Missing secret token header');
        return false;
    }

    const secretToken = crypto.createHash('sha256')
        .update(TELEGRAM_BOT_TOKEN)
        .digest('hex');
    console.log('Calculated secret token:', secretToken);

    const isValid = signatureHeader === secretToken;
    console.log('Webhook verification result:', isValid ? 'Success' : 'Failure');

    return isValid;
}

async function sendLongMessage(chatId, text) {
    const maxLength = 4000; // Leave some room for formatting
    const parts = [];

    while (text.length > 0) {
        if (text.length > maxLength) {
            let part = text.substr(0, maxLength);
            let lastParagraph = part.lastIndexOf('\n\n');
            if (lastParagraph > 0) {
                part = part.substr(0, lastParagraph);
            } else {
                let lastSpace = part.lastIndexOf(' ');
                if (lastSpace > 0) {
                    part = part.substr(0, lastSpace);
                }
            }
            parts.push(part);
            text = text.substr(part.length);
        } else {
            parts.push(text);
            break;
        }
    }

    for (let i = 0; i < parts.length; i++) {
        await bot.sendMessage(chatId, parts[i], { parse_mode: 'Markdown' });
    }
}

// Function to check if file size is within limits
function isFileSizeValid(fileSize) {
    return fileSize <= MAX_FILE_SIZE;
}

async function handleMediaMessage(message) {
    const chatId = message.chat.id;
    let fileId, fileSize, mediaType, mimeType;

    if (message.voice) {
        fileId = message.voice.file_id;
        fileSize = message.voice.file_size;
        mediaType = 'voice';
        mimeType = 'audio/ogg';
    } else if (message.audio) {
        fileId = message.video.file_id;
        fileSize = message.video.file_size;
        mediaType = 'voice';
        mimeType = 'audio/mpeg';
    } else if (message.video) {
        fileId = message.video.file_id;
        fileSize = message.video.file_size;
        mediaType = 'video';
        mimeType = 'video/mp4';
    } else if (message.video_note) {
        fileId = message.video_note.file_id;
        fileSize = message.video_note.file_size;
        mediaType = 'video_note';
        mimeType = 'video/mp4';
    } else {
        throw new Error('Unsupported media type');
    }

    try {
        console.log(`Processing ${mediaType} message. File ID:`, fileId, 'File Size:', fileSize);

        if (!isFileSizeValid(fileSize)) {
            console.log('File size exceeds the limit');
            await bot.sendMessage(chatId, `Извините, размер файла превышает ограничение в ${MAX_FILE_SIZE / (1024 * 1024)} МБ. Пожалуйста, отправьте файл меньшего размера.`);
            return;
        }

        await bot.sendMessage(chatId, `Транскрибирую ваше ${mediaType === 'voice' ? 'аудио' : 'видео'}...`);

        console.log('Attempting to get file link...');
        const fileLink = await bot.getFileLink(fileId);
        console.log('File link obtained:', fileLink);

        console.log('Downloading file...');
        const fileResponse = await axios({
            method: 'get',
            url: fileLink,
            responseType: 'arraybuffer'
        });
        console.log('File downloaded. Size:', fileResponse.data.length, 'bytes');

        const mediaBuffer = fileResponse.data;

        const transcriptionOptions = {
            mimetype: mimeType,
            smart_format: true,
            paragraph: true,
            model: 'nova-2',
            language: 'multi',
            detect_language: true
        };

        console.log('Sending media to Deepgram for transcription');
        const { result, error } = await deepgramClient.listen.prerecorded.transcribeFile(
            mediaBuffer,
            transcriptionOptions
        );

        if (error) {
            console.error('Deepgram API error:', error);
            throw new Error(`Deepgram API error: ${error.message}`);
        }

        console.log('Transcription received');
        console.log('Full Deepgram response:', JSON.stringify(result, null, 2));

        if (!result || !result.results || !result.results.channels || result.results.channels.length === 0) {
            console.error('Unexpected Deepgram response structure:', JSON.stringify(result, null, 2));
            throw new Error('Unexpected Deepgram response structure');
        }

        const transcribedText = result.results.channels[0].alternatives[0].transcript;
        const confidence = result.results.channels[0].alternatives[0].confidence;
        const detectedLanguage = result.results.channels[0].detected_language;

        console.log('Transcription:', transcribedText);
        console.log('Confidence:', confidence);
        console.log('Detected language:', detectedLanguage);

        let responseMessage = '';

        responseMessage += `*Определен язык:* ${getLanguageName(detectedLanguage)}\n\n`;
        responseMessage += `*Уверенность:* ${(confidence * 100).toFixed(2)}%\n\n`;
        responseMessage += `*Транскрипция:*\n\n${formatTranscription(transcribedText)}`;

        if (confidence < 0.6) {
            responseMessage += '\n\n_Примечание: Уверенность в транскрипции низкая. Результат может быть неточным._';
        }

        await sendLongMessage(chatId, responseMessage);
        console.log('Transcription sent to user');

    } catch (error) {
        console.error('Error processing media message:', error);
        console.error('Error stack:', error.stack);

        let errorMessage = `Извините, произошла ошибка при обработке вашего ${mediaType === 'voice' ? 'голосового сообщения' : 'видео'}.`;

        if (error.message.includes('file is too big')) {
            errorMessage = `Извините, размер файла слишком большой для обработки. Максимальный размер файла: ${MAX_FILE_SIZE / (1024 * 1024)} МБ.`;
        }

        await bot.sendMessage(chatId, errorMessage);
    }
}

function getLanguageName(languageCode) {
    switch (languageCode) {
        case 'en-US':
            return 'Английский';
        case 'ru-RU':
            return 'Русский';
        default:
            return languageCode;
    }
}

function formatTranscription(text) {
    // Split the text into sentences
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    // Group sentences into paragraphs (e.g., 3 sentences per paragraph)
    const paragraphs = [];
    for (let i = 0; i < sentences.length; i += 3) {
        const paragraph = sentences.slice(i, i + 3).join(' ').trim();
        paragraphs.push(paragraph);
    }

    // Join paragraphs with double line breaks
    return paragraphs.join('\n\n');
}

// For Vercel serverless function
export default async (req, res) => {
    console.log('Received request:', req.method);
    console.log('Request headers:', JSON.stringify(req.headers, null, 2));
    console.log('Request body:', JSON.stringify(req.body, null, 2));

    if (!verifyTelegramWebhook(req)) {
        console.error('Webhook verification failed');
        return res.status(401).send('Unauthorized');
    }

    if (req.method === 'POST') {
        try {
            const { message } = req.body;
            console.log('Received message:', JSON.stringify(message));

            if (message.voice || message.audio || message.video || message.video_note) {
                await handleMediaMessage(message);
            } 
            // else if (message.text) {
            //     await bot.sendMessage(message.chat.id, `Вы сказали: ${message.text}`);
            //     console.log('Echo sent to user');
            // } else {
            //     console.log('Received unsupported message type');
            //     await bot.sendMessage(message.chat.id, 'Пожалуйста, отправьте голосовое сообщение или видео для транскрибации.');
            // }

            res.status(200).send('OK');
        } catch (error) {
            console.error('Error handling POST request:', error);
            console.error('Error stack:', error.stack);
            res.status(500).send('Internal Server Error');
        }
    } else {
        console.log('Received GET request, sending OK response');
        res.status(200).send('Telegram Bot is active!');
    }
};