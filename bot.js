// bot.js

const TelegramBot = require('node-telegram-bot-api');

console.log('Starting bot initialization...');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in the environment variables');
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// For Vercel serverless function
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            const { message } = req.body;
            console.log('Received message:', JSON.stringify(message));

            if (message && message.text) {
                await bot.sendMessage(message.chat.id, `You said: ${message.text}`);
                console.log('Echo sent to user');
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