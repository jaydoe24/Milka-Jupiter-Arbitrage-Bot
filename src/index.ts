// This file serves as the entry point for the application, initializing the bot and setting up necessary configurations.

import { Bot } from './bot';
import { config } from './config/default';

const startBot = async () => {
    const bot = new Bot(config);
    await bot.initialize();
    bot.start();
};

startBot().catch(error => {
    console.error('Error starting the bot:', error);
});