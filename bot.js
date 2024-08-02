const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require("@deepgram/sdk");
const crypto = require('crypto');

console.log('Starting bot initialization...');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

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

// Function to generate a cache key
function generateCacheKey(voiceFileId, options) {
    const optionsString = JSON.stringify(options);
    return crypto.createHash('md5').update(`${voiceFileId}:${optionsString}`).digest('hex');
}

// Function to get cached result or transcribe with Deepgram
async function getTranscription(voiceFileId, audioBuffer, options) {
    const cacheKey = generateCacheKey(voiceFileId, options);

    if (cache.has(cacheKey)) {
        console.log('Cache hit for:', cacheKey);
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

async function handleVoiceMessage(message) {
    const chatId = message.chat.id;
    const voiceFileId = message.voice.file_id;

    try {
        console.log('Processing voice message. File ID:', voiceFileId);
        await bot.sendMessage(chatId, 'Transcribing your voice message...');

        console.log('Attempting to get file link...');
        const voiceFileLink = await bot.getFileLink(voiceFileId);
        console.log('Voice file link obtained:', voiceFileLink);

        console.log('Downloading voice file...');
        const voiceFileResponse = await axios({
            method: 'get',
            url: voiceFileLink,
            responseType: 'arraybuffer'
        });
        console.log('Voice file downloaded. Size:', voiceFileResponse.data.length, 'bytes');

        const transcriptionOptions = {
            mimetype: 'audio/ogg',
            smart_format: true,
            paragraph: true,
            model: 'nova-2',
            detect_language: true
        };

        const result = await getTranscription(voiceFileId, voiceFileResponse.data, transcriptionOptions);

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

        responseMessage += `*Detected language:* ${getLanguageName(detectedLanguage)}\n\n`;
        responseMessage += `*Confidence:* ${(confidence * 100).toFixed(2)}%\n\n`;
        responseMessage += `*Transcription:*\n\n${formatTranscription(transcribedText)}`;

        if (confidence < 0.6) {
            responseMessage += '\n\n_Note: The transcription confidence is low. The result might not be accurate._';
        }

        await sendLongMessage(chatId, responseMessage);
        console.log('Transcription sent to user');

    } catch (error) {
        console.error('Error processing voice message:', error);
        console.error('Error stack:', error.stack);
        await bot.sendMessage(chatId, `Sorry, there was an error processing your voice message: ${error.message}`);
    }
}

function getLanguageName(languageCode) {
    switch (languageCode) {
        case 'en-US':
            return 'English';
        case 'ru-RU':
            return 'Russian';
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
        paragraphs.push(sentences.slice(i, i + 3).join(' '));
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

            if (message.voice) {
                await handleVoiceMessage(message);
            } else if (message.text) {
                await bot.sendMessage(message.chat.id, `You said: ${message.text}`);
                console.log('Echo sent to user');
            } else {
                console.log('Received unsupported message type');
                await bot.sendMessage(message.chat.id, 'Please send a voice message for transcription.');
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