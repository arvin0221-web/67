// register-commands.js
// 執行一次即可：node register-commands.js
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName('werewolf')
    .setDescription('開始一場狼人殺遊戲')
    .addIntegerOption(o => o
      .setName('mode').setDescription('選擇遊戲模式').setRequired(true)
      .addChoices(
        { name: '6人模式（屠城局）', value: 6 },
        { name: '9人模式（屠邊局）', value: 9 },
      )
    ),
  new SlashCommandBuilder()
    .setName('roles')
    .setDescription('查看所有角色說明'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('查看當前遊戲狀態'),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('正在註冊 Slash Commands...');
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('✅ 註冊成功！');
  } catch (e) {
    console.error('❌ 失敗:', e);
  }
})();
