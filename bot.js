// bot.js

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

// Function to verify Telegram webhook
function verifyTelegramWebhook(req) {
    if (req.method !== 'POST') {
        return false;
    }

    const signatureHeader = req.headers['x-telegram-bot-api-secret-token'];

    if (!signatureHeader) {
        return false;
    }

    const secretToken = crypto.createHash('sha256')
        .update(TELEGRAM_BOT_TOKEN)
        .digest('hex');

    return signatureHeader === secretToken;
}

async function handleVoiceMessage(message) {
    const chatId = message.chat.id;
    const voiceFileId = message.voice.file_id;

    try {
        console.log('Processing voice message. File ID:', voiceFileId);
        await bot.sendMessage(chatId, 'Transcribing your voice message...');

        const voiceFileLink = await bot.getFileLink(voiceFileId);
        console.log('Voice file link obtained:', voiceFileLink);

        const voiceFileResponse = await axios({
            method: 'get',
            url: voiceFileLink,
            responseType: 'arraybuffer'
        });
        console.log('Voice file downloaded. Size:', voiceFileResponse.data.length, 'bytes');

        console.log('Sending audio to Deepgram for transcription');
        const { result, error } = await deepgramClient.listen.prerecorded.transcribeFile(
            voiceFileResponse.data,
            {
                mimetype: 'audio/ogg',
                smart_format: true,
                model: 'nova-2',
            }
        );

        console.log('Full Deepgram response:', JSON.stringify({ result, error }, null, 2));

        if (error) {
            throw new Error(`Deepgram API error: ${error.message}`);
        }

        if (!result || !result.results || !result.results.channels || result.results.channels.length === 0) {
            throw new Error('Unexpected Deepgram response structure');
        }

        const transcribedText = result.results.channels[0].alternatives[0].transcript;
        console.log('Transcription received:', transcribedText);

        if (!transcribedText) {
            await bot.sendMessage(chatId, 'Sorry, the transcription was empty. Please try speaking more clearly or in a quieter environment.');
        } else {
            await bot.sendMessage(chatId, `Transcription: ${transcribedText}`);
        }
        console.log('Transcription sent to user');

    } catch (error) {
        console.error('Error processing voice message:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error processing your voice message.');
    }
}

// For Vercel serverless function
module.exports = async (req, res) => {
    console.log('Received request:', req.method);

    if (!verifyTelegramWebhook(req)) {
        console.error('Webhook verification failed');
        return res.status(401).send('Unauthorized');
    }

    if (req.method === 'POST') {
        try {
            const { message } = req.body;
            console.log('Received message:', JSON.stringify(message));

            if (message.text) {
                await bot.sendMessage(message.chat.id, `You said: ${message.text}`);
                console.log('Echo sent to user');
            } else if (message.voice) {
                await handleVoiceMessage(message);
            } else {
                console.log('Received unsupported message type');
                await bot.sendMessage(message.chat.id, 'Please send a text or voice message.');
            }

            res.status(200).send('OK');
        } catch (error) {
            console.error('Error handling POST request:', error);
            res.status(500).send('Internal Server Error');
        }
    } else {
        console.log('Received GET request, sending OK response');
        res.status(200).send('Telegram Bot is active!');
    }
};