// index.js
import { Client, GatewayIntentBits, EmbedBuilder, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

// 自動註冊 Slash Commands（每次啟動執行，已存在的指令會自動更新）
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('werewolf').setDescription('開始一場狼人殺遊戲')
      .addIntegerOption(o => o.setName('mode').setDescription('選擇遊戲模式').setRequired(true)
        .addChoices({ name: '6人模式（屠城局）', value: 6 }, { name: '9人模式（屠邊局）', value: 9 })),
    new SlashCommandBuilder().setName('roles').setDescription('查看所有角色說明'),
    new SlashCommandBuilder().setName('status').setDescription('查看當前遊戲狀態'),
    new SlashCommandBuilder().setName('endgame').setDescription('強制結束當前遊戲（房主或管理員使用）'),
  ];
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('✅ Slash Commands 註冊完成');
  } catch (e) {
    console.error('❌ Slash Commands 註冊失敗:', e.message);
  }
}


import { ROLES, ROLE_NAMES, ROLE_DESCRIPTIONS, TEAM, GAME_PHASE } from './constants.js';
import {
  getGame, hasGame, createGame, destroyGame,
  buildLobbyEmbed, buildJoinButtons,
  startNight, startVote, registerVote,
  completeWolfKill, completeSeerCheck,
  completeWitchSave, completeWitchPoison,
  completeHunterShot,
} from './GameEngine.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let botIdCounter = 1;
const BOT_NAMES = ['艾里克斯', '波菲洛', '卡蒙', '黛安', '伊莎', '法蘭克', '葛蕾絲', '海克', '艾維'];

client.once('ready', async () => {
  console.log(`✅ 狼人殺Bot已上線：${client.user.tag}`);
  client.user.setActivity('狼人殺 🐺', { type: 0 });
  await registerCommands(); // 自動註冊指令，不需要手動跑 register-commands.js
});

// ── 解析 customId 中的 channelId（最後一段，避免含底線的ID出問題）──
function extractChannelId(customId, prefix) {
  return customId.slice(prefix.length);
}

client.on('interactionCreate', async interaction => {

  // ─── Slash Commands ───────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName, channelId } = interaction;

    if (commandName === 'werewolf') {
      if (hasGame(channelId))
        return interaction.reply({ content: '❌ 這個頻道已有進行中的遊戲！', ephemeral: true });
      const mode = interaction.options.getInteger('mode');
      const game = createGame(channelId, mode);
      return interaction.reply({ embeds: [buildLobbyEmbed(game)], components: [buildJoinButtons()] });
    }

    if (commandName === 'roles') {
      const fields = Object.entries(ROLE_NAMES).map(([role, name]) => ({
        name, value: ROLE_DESCRIPTIONS[role], inline: false,
      }));
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x2B2D31).setTitle('📖 狼人殺角色說明').addFields(fields)],
        ephemeral: true,
      });
    }

    if (commandName === 'endgame') {
      if (!hasGame(channelId))
        return interaction.reply({ content: '目前沒有進行中的遊戲。', ephemeral: true });
      destroyGame(channelId);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x8B0000).setTitle('🛑 遊戲已強制結束').setDescription('可以用 `/werewolf` 開新遊戲了。')],
      });
    }

    if (commandName === 'status') {
      const game = getGame(channelId);
      if (!game) return interaction.reply({ content: '目前沒有進行中的遊戲。', ephemeral: true });
      const phaseMap = {
        [GAME_PHASE.WAITING]: '等待中', [GAME_PHASE.NIGHT]: '🌙夜晚',
        [GAME_PHASE.DAY]: '☀️白天', [GAME_PHASE.VOTE]: '🗳️投票中', [GAME_PHASE.ENDED]: '已結束',
      };
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x2B2D31).setTitle('🎮 遊戲狀態')
          .addFields(
            { name: '模式', value: game.mode.name, inline: true },
            { name: '階段', value: phaseMap[game.phase], inline: true },
            { name: `第 ${game.day} 天`, value: '\u200b', inline: true },
            { name: '玩家', value: game.formatPlayerList() },
          )],
        ephemeral: true,
      });
    }
    return;
  }

  // ─── Buttons ──────────────────────────────────────────
  if (interaction.isButton()) {
    const { customId, channelId, user } = interaction;

    // 大廳按鈕（在頻道中）
    const game = getGame(channelId);

    if (customId === 'join_game') {
      if (!game || game.phase !== GAME_PHASE.WAITING)
        return interaction.reply({ content: '遊戲不在等待階段。', ephemeral: true });
      if (game.players.has(user.id))
        return interaction.reply({ content: '你已加入！', ephemeral: true });
      if (game.players.size >= game.mode.total)
        return interaction.reply({ content: '人數已滿！', ephemeral: true });
      game.addPlayer(user.id, user.username, false);
      return interaction.update({ embeds: [buildLobbyEmbed(game)], components: [buildJoinButtons()] });
    }

    if (customId === 'add_bot') {
      if (!game || game.phase !== GAME_PHASE.WAITING)
        return interaction.reply({ content: '遊戲不在等待階段。', ephemeral: true });
      if (game.players.size >= game.mode.total)
        return interaction.reply({ content: '人數已滿！', ephemeral: true });
      const name = BOT_NAMES[(botIdCounter - 1) % BOT_NAMES.length];
      game.addPlayer(`bot_${botIdCounter++}_${Date.now()}`, name, true);
      return interaction.update({ embeds: [buildLobbyEmbed(game)], components: [buildJoinButtons()] });
    }

    if (customId === 'start_game') {
      if (!game || game.phase !== GAME_PHASE.WAITING)
        return interaction.reply({ content: '無法開始。', ephemeral: true });
      if (game.players.size < game.mode.total)
        return interaction.reply({ content: `人數不足！目前 ${game.players.size}/${game.mode.total} 人。`, ephemeral: true });

      game.assignRoles();
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x2E8B57)
          .setTitle('🏘️ 遊戲開始！')
          .setDescription('角色已分配，請查看私訊確認你的角色！遊戲即將開始...')
          .addFields({ name: '玩家列表', value: game.formatPlayerList() })],
        components: [],
      });

      // 私訊每位真人玩家
      for (const player of game.players.values()) {
        if (!player.isBot) {
          try {
            const u = await client.users.fetch(player.id);
            const wolfAllies = game.aliveWolves.filter(p => p.id !== player.id);
            let extra = '';
            if (player.role === ROLES.WEREWOLF && wolfAllies.length > 0)
              extra = `\n\n🐺 你的狼人同伴：${wolfAllies.map(p => p.displayName).join(', ')}`;
            await u.send({ embeds: [new EmbedBuilder()
              .setColor(player.team === TEAM.WEREWOLF ? 0x8B0000 : 0x2E8B57)
              .setTitle('🎭 你的角色')
              .setDescription(`**${ROLE_NAMES[player.role]}**\n\n${ROLE_DESCRIPTIONS[player.role]}${extra}`)] });
          } catch (e) { console.error(`私訊 ${player.username} 失敗:`, e.message); }
        }
      }

      // 直接用 interaction.channel，不用 fetch（避免權限問題）
      const ch = interaction.channel;
      startNight(game, ch, client).catch(e => console.error('startNight 錯誤:', e));
      return;
    }

    if (customId === 'cancel_game') {
      if (!game || game.phase !== GAME_PHASE.WAITING)
        return interaction.reply({ content: '無法取消。', ephemeral: true });
      destroyGame(channelId);
      return interaction.update({
        embeds: [new EmbedBuilder().setColor(0x8B0000).setTitle('❌ 遊戲已取消')],
        components: [],
      });
    }

    // 投票按鈕
    if (customId.startsWith('vote_')) {
      const targetId = customId.slice(5);
      if (!game || game.phase !== GAME_PHASE.VOTE)
        return interaction.reply({ content: '現在不是投票時間。', ephemeral: true });
      const voter = game.players.get(user.id);
      if (!voter || !voter.alive)
        return interaction.reply({ content: '你無法投票。', ephemeral: true });
      if (game.voteMap.has(user.id))
        return interaction.reply({ content: '你已投票！', ephemeral: true });
      await registerVote(game, user.id, targetId, interaction.channel, client);
      return interaction.reply({ content: `✅ 已投票放逐 **${game.getPlayer(targetId)?.displayName || '?'}**`, ephemeral: true });
    }

    // 女巫解藥（來自 DM，channelId 是 DM，需從 customId 取遊戲頻道ID）
    if (customId.startsWith('witch_save_yes_') || customId.startsWith('witch_save_no_')) {
      const save = customId.startsWith('witch_save_yes_');
      const gameChannelId = save
        ? extractChannelId(customId, 'witch_save_yes_')
        : extractChannelId(customId, 'witch_save_no_');
      const targetGame = getGame(gameChannelId);
      if (!targetGame) return interaction.update({ embeds: [new EmbedBuilder().setDescription('遊戲已結束。')], components: [] });
      await interaction.update({ components: [] });
      const ch = await client.channels.fetch(gameChannelId);
      await completeWitchSave(targetGame, user.id, save, client, ch);
      return;
    }

    return;
  }

  // ─── Select Menus ─────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const { customId, channelId, user, values } = interaction;
    const selectedId = values[0];

    // 狼人擊殺
    if (customId.startsWith('wolf_kill_')) {
      const gameChannelId = extractChannelId(customId, 'wolf_kill_');
      const targetGame = getGame(gameChannelId);
      if (!targetGame) return interaction.update({ embeds: [new EmbedBuilder().setDescription('遊戲已結束。')], components: [] });
      const wolf = targetGame.players.get(user.id);
      if (!wolf || wolf.role !== ROLES.WEREWOLF)
        return interaction.reply({ content: '你不是狼人！', ephemeral: true });
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x8B0000).setTitle('✅ 目標已選定')
          .setDescription(`今晚將擊殺：**${targetGame.getPlayer(selectedId)?.displayName || '?'}**`)],
        components: [],
      });
      const ch = await client.channels.fetch(gameChannelId);
      await completeWolfKill(targetGame, selectedId, ch, client);
      return;
    }

    // 預言家查驗
    if (customId.startsWith('seer_check_')) {
      const gameChannelId = extractChannelId(customId, 'seer_check_');
      const targetGame = getGame(gameChannelId);
      if (!targetGame) return interaction.update({ embeds: [new EmbedBuilder().setDescription('遊戲已結束。')], components: [] });
      const seer = targetGame.players.get(user.id);
      if (!seer || seer.role !== ROLES.SEER)
        return interaction.reply({ content: '你不是預言家！', ephemeral: true });
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle('🔮 正在查驗...')], components: [],
      });
      const ch = await client.channels.fetch(gameChannelId);
      await completeSeerCheck(targetGame, user.id, selectedId, client, ch);
      return;
    }

    // 女巫毒藥
    if (customId.startsWith('witch_poison_')) {
      const gameChannelId = extractChannelId(customId, 'witch_poison_');
      const targetGame = getGame(gameChannelId);
      if (!targetGame) return interaction.update({ embeds: [new EmbedBuilder().setDescription('遊戲已結束。')], components: [] });
      const witch = targetGame.players.get(user.id);
      if (!witch || witch.role !== ROLES.WITCH)
        return interaction.reply({ content: '你不是女巫！', ephemeral: true });
      await interaction.update({ components: [] });
      const ch = await client.channels.fetch(gameChannelId);
      await completeWitchPoison(targetGame, user.id, selectedId, client, ch);
      return;
    }

    // 獵人開槍
    if (customId.startsWith('hunter_shoot_')) {
      const gameChannelId = extractChannelId(customId, 'hunter_shoot_');
      const targetGame = getGame(gameChannelId);
      if (!targetGame) return interaction.update({ embeds: [new EmbedBuilder().setDescription('遊戲已結束。')], components: [] });
      const hunter = targetGame.players.get(user.id);
      if (!hunter || hunter.role !== ROLES.HUNTER)
        return interaction.reply({ content: '你不是獵人！', ephemeral: true });
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x8B4513).setTitle('🏹 開槍！')], components: [],
      });
      const ch = await client.channels.fetch(gameChannelId);
      await completeHunterShot(targetGame, selectedId, ch, client);
      return;
    }

    // 投票選單
    if (customId === 'vote_select') {
      const game = getGame(channelId);
      if (!game || game.phase !== GAME_PHASE.VOTE)
        return interaction.reply({ content: '現在不是投票時間。', ephemeral: true });
      const voter = game.players.get(user.id);
      if (!voter || !voter.alive)
        return interaction.reply({ content: '你無法投票。', ephemeral: true });
      if (game.voteMap.has(user.id))
        return interaction.reply({ content: '你已投票！', ephemeral: true });
      await registerVote(game, user.id, selectedId, interaction.channel, client);
      return interaction.reply({ content: `✅ 已投票放逐 **${game.getPlayer(selectedId)?.displayName || '?'}**`, ephemeral: true });
    }

    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
