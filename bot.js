const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require("@deepgram/sdk");
const crypto = require('crypto');
const { FFmpeg } = require('@ffmpeg/ffmpeg');
const { fetchFile, toBlobURL } = require('@ffmpeg/util');

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

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Cache hit counter
let cacheHits = 0;

// Function to generate a cache key based on file hash and options
function generateCacheKey(fileHash, options) {
    const optionsString = JSON.stringify(options);
    return crypto.createHash('md5').update(`${fileHash}:${optionsString}`).digest('hex');
}

// Function to calculate file hash
function calculateFileHash(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
}

// Function to get cached result or transcribe with Deepgram
async function getTranscription(audioBuffer, options) {
    const fileHash = calculateFileHash(audioBuffer);
    const cacheKey = generateCacheKey(fileHash, options);

    if (cache.has(cacheKey)) {
        console.log('Cache hit for:', cacheKey);
        cacheHits++;
        return cache.get(cacheKey);
    }

    console.log('Cache miss for:', cacheKey);
    console.log('Sending audio to Deepgram for transcription');
    const { result, error } = await deepgramClient.listen.prerecorded.transcribeFile(
        audioBuffer,
        options
    );

    if (error) {
        console.error('Deepgram API error:', error);
        throw new Error(`Deepgram API error: ${error.message}`);
    }

    // Cache the result
    cache.set(cacheKey, result);
    setTimeout(() => cache.delete(cacheKey), CACHE_TTL);

    return result;
}

// Function to get cache status
function getCacheStatus() {
    return {
        size: cache.size,
        hits: cacheHits
    };
}

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

async function extractAudioFromVideo(videoBuffer) {
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.2/dist/umd'
    await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    await ffmpeg.writeFile('input.mp4', await fetchFile(videoBuffer));
    await ffmpeg.exec(['-i', 'input.mp4', '-vn', '-acodec', 'copy', 'output.aac']);
    const data = await ffmpeg.readFile('output.aac');

    return new Uint8Array(data);
}

async function handleMediaMessage(message) {
    const chatId = message.chat.id;
    let fileId, fileSize, mediaType, mimeType;

    if (message.voice) {
        fileId = message.voice.file_id;
        fileSize = message.voice.file_size;
        mediaType = 'voice';
        mimeType = 'audio/ogg';
    } else if (message.video) {
        fileId = message.video.file_id;
        fileSize = message.video.file_size;
        mediaType = 'video';
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

        await bot.sendMessage(chatId, `Транскрибирую ваше ${mediaType === 'voice' ? 'голосовое сообщение' : 'видео'}...`);

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

        let audioBuffer = fileResponse.data;
        if (mediaType === 'video') {
            console.log('Extracting audio from video...');
            audioBuffer = await extractAudioFromVideo(fileResponse.data);
            console.log('Audio extracted. Size:', audioBuffer.length, 'bytes');
            mimeType = 'audio/aac'; // Update mimeType for extracted audio
        }

        const transcriptionOptions = {
            mimetype: mimeType,
            smart_format: true,
            paragraph: true,
            model: 'nova-2',
            detect_language: true
        };

        const result = await getTranscription(audioBuffer, transcriptionOptions);

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
module.exports = async (req, res) => {
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

            if (message.voice || message.video) {
                await handleMediaMessage(message);
            } else if (message.text) {
                if (message.text.toLowerCase() === '/cachestatus') {
                    const status = getCacheStatus();
                    await bot.sendMessage(message.chat.id, `Статус кэша:\nРазмер: ${status.size}\nПопаданий: ${status.hits}`);
                } else {
                    await bot.sendMessage(message.chat.id, `Вы сказали: ${message.text}`);
                    console.log('Echo sent to user');
                }
            } else {
                console.log('Received unsupported message type');
                await bot.sendMessage(message.chat.id, 'Пожалуйста, отправьте голосовое сообщение или видео для транскрибации.');
            }

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