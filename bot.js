// bot.js

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require("@deepgram/sdk");

console.log('Starting bot initialization...');

// Load environment variables based on the environment
if (process.env.VERCEL_URL) {
    console.log('Running on Vercel');
} else {
    console.log('Running locally');
    require('dotenv').config();
}

// Initialize bot with your Telegram token
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

console.log('TELEGRAM_BOT_TOKEN:', TELEGRAM_BOT_TOKEN ? 'Set' : 'Not set');
console.log('DEEPGRAM_API_KEY:', DEEPGRAM_API_KEY ? 'Set' : 'Not set');

if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is not set in the environment variables');
}

if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in the environment variables');
}

// Initialize Deepgram client
const deepgramClient = createClient(DEEPGRAM_API_KEY);
console.log('Deepgram client initialized successfully');

// Determine if we're running on Vercel
const isVercel = process.env.VERCEL_URL !== undefined;

let bot;
try {
    if (isVercel) {
        // Create a bot instance for Vercel (webhook mode)
        bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
        bot.setWebHook(`https://${process.env.VERCEL_URL}/api/bot`);
        console.log('Bot initialized in webhook mode');
    } else {
        // Create a bot instance for local development (polling mode)
        bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
            polling: true,
            cancellation: true
        });
        console.log('Bot initialized in polling mode');
    }
} catch (error) {
    console.error('Error initializing Telegram bot:', error);
    throw error;
}

// Handler for voice messages
async function handleVoiceMessage(message) {
    const chatId = message.chat.id;
    const voiceFileId = message.voice.file_id;

    try {
        console.log('Received voice message, starting transcription process');
        await bot.sendMessage(chatId, 'Transcribing your voice message...');

        const voiceFilePath = await bot.getFileLink(voiceFileId);
        console.log('Voice file path obtained:', voiceFilePath);

        const voiceFileResponse = await axios({
            method: 'get',
            url: voiceFilePath,
            responseType: 'arraybuffer'
        });
        console.log('Voice file downloaded successfully');

        console.log('Sending audio to Deepgram for transcription');
        const { result, error } = await deepgramClient.listen.prerecorded.transcribeFile(
            voiceFileResponse.data,
            {
                smart_format: true,
                model: 'general',
                mimetype: 'audio/ogg'
            }
        );

        if (error) {
            throw new Error(`Deepgram transcription error: ${error}`);
        }

        const transcribedText = result.results.channels[0].alternatives[0].transcript;
        console.log('Transcription received:', transcribedText);

        await bot.sendMessage(chatId, `Transcription: ${transcribedText}`);
        console.log('Transcription sent to user');

    } catch (error) {
        console.error('Error processing voice message:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error processing your voice message.');
    }
}

// Set up the message handler
bot.on('voice', handleVoiceMessage);

console.log('Bot setup completed');

// For Vercel serverless function
module.exports = async (req, res) => {
    console.log('Received request:', req.method);
    if (req.method === 'POST') {
        try {
            const update = req.body;
            console.log('Received update:', JSON.stringify(update));
            if (update.message && update.message.voice) {
                await handleVoiceMessage(update.message);
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