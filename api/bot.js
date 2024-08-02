// bot.js

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Deepgram } = require('@deepgram/sdk');

// Load environment variables based on the environment
if (process.env.VERCEL_URL) {
    // We're on Vercel, environment variables are set in the Vercel dashboard
    console.log('Running on Vercel');
} else {
    // We're running locally, use dotenv to load environment variables
    require('dotenv').config();
    console.log('Running locally');
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
const deepgramClient = new Deepgram(DEEPGRAM_API_KEY);

// Determine if we're running on Vercel
const isVercel = process.env.VERCEL_URL !== undefined;

let bot;
if (isVercel) {
    // Create a bot instance for Vercel (webhook mode)
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
    bot.setWebHook(`https://${process.env.VERCEL_URL}/api/bot`);
} else {
    // Create a bot instance for local development (polling mode)
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
        polling: true,
        // Explicitly enable promise cancellation
        cancellation: true
    });
}

// Handler for voice messages
async function handleVoiceMessage(message) {
    const chatId = message.chat.id;
    const voiceFileId = message.voice.file_id;

    try {
        // Inform the user that transcription is in progress
        await bot.sendMessage(chatId, 'Transcribing your voice message...');

        // Get the file path of the voice message
        const voiceFilePath = await bot.getFileLink(voiceFileId);

        // Download the voice file
        const voiceFileResponse = await axios({
            method: 'get',
            url: voiceFilePath,
            responseType: 'arraybuffer'
        });

        // Prepare audio source for Deepgram
        const audioSource = {
            buffer: voiceFileResponse.data,
            mimetype: 'audio/ogg'
        };

        // Transcribe the audio using Deepgram
        const transcriptionResponse = await deepgramClient.transcription.preRecorded(audioSource, {
            smart_format: true,
            model: 'general',
        });

        // Extract the transcribed text
        const transcribedText = transcriptionResponse.results.channels[0].alternatives[0].transcript;

        // Send the transcribed text back to the user
        await bot.sendMessage(chatId, `Transcription: ${transcribedText}`);

    } catch (error) {
        console.error('Error processing voice message:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error processing your voice message.');
    }
}

// Set up the message handler
bot.on('voice', handleVoiceMessage);

// For local development
if (!isVercel) {
    console.log('Bot is running in polling mode (local development)');
}

// For Vercel serverless function
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const update = req.body;
        if (update.message && update.message.voice) {
            await handleVoiceMessage(update.message);
        }
        res.status(200).send('OK');
    } else {
        res.status(200).send('Telegram Bot is active!');
    }
};