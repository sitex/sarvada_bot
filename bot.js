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

        console.log('Sending audio to Deepgram for transcription');
        const { result, error } = await deepgramClient.listen.prerecorded.transcribeFile(
            voiceFileResponse.data,
            {
                mimetype: 'audio/ogg',
                smart_format: true,
                model: 'nova-2',
                // language: 'en,ru',
                detect_language: true
            }
        );

        if (error) {
            console.error('Deepgram API error:', error);
            throw new Error(`Deepgram API error: ${error.message}`);
        }

        console.log('Deepgram response received');
        console.log('Full Deepgram response:', JSON.stringify(result, null, 2));

        if (!result || !result.results || !result.results.channels || result.results.channels.length === 0) {
            console.error('Unexpected Deepgram response structure:', JSON.stringify(result, null, 2));
            throw new Error('Unexpected Deepgram response structure');
        }

        const transcribedText = result.results.channels[0].alternatives[0].transcript;
        const confidence = result.results.channels[0].alternatives[0].confidence;
        const detectedLanguage = result.results.channels[0].detected_language;

        console.log('Transcription received:', transcribedText);
        console.log('Confidence:', confidence);
        console.log('Detected language:', detectedLanguage);

        let responseMessage = '';

        if (detectedLanguage === 'en') {
            responseMessage += 'Detected language: English\n';
        } else if (detectedLanguage === 'ru') {
            responseMessage += 'Detected language: Russian\n';
        } else {
            responseMessage += `Detected language: ${detectedLanguage}\n`;
        }

        responseMessage += `Confidence: ${(confidence * 100).toFixed(2)}%\n`;
        responseMessage += `Transcription: ${transcribedText}`;

        if (confidence < 0.6) {
            responseMessage += '\n\nNote: The transcription confidence is low. The result might not be accurate.';
        }

        await bot.sendMessage(chatId, responseMessage);
        console.log('Transcription sent to user');

    } catch (error) {
        console.error('Error processing voice message:', error);
        console.error('Error stack:', error.stack);
        await bot.sendMessage(chatId, `Sorry, there was an error processing your voice message: ${error.message}`);
    }
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