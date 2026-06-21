// index.js
import { Client, GatewayIntentBits, EmbedBuilder, Partials, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('werewolf').setDescription('開始一場狼人殺遊戲')
      .addIntegerOption(o => o.setName('mode').setDescription('選擇遊戲模式').setRequired(true)
        .addChoices({ name: '6人模式（屠城局）', value: 6 }, { name: '9人模式（屠邊局）', value: 9 })),
    new SlashCommandBuilder().setName('roles').setDescription('查看所有角色說明'),
    new SlashCommandBuilder().setName('status').setDescription('查看當前遊戲狀態'),
    new SlashCommandBuilder().setName('endgame').setDescription('強制結束當前遊戲'),
  ];
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Slash Commands 註冊完成');
  } catch (e) { console.error('❌ 註冊失敗:', e.message); }
}

import { ROLES, ROLE_NAMES, ROLE_DESCRIPTIONS, TEAM, GAME_PHASE } from './constants.js';
import {
  getGame, hasGame, createGame, destroyGame,
  buildLobbyEmbed, buildJoinButtons, setupThreads,
  startNight, startVote, registerVote,
  completeWolfKill, completeSeerCheck,
  completeWitchSave, completeWitchPoison,
  completeHunterShot, handlePlayerSpeak,
} from './GameEngine.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let botIdCounter = 1;
const BOT_NAMES = ['艾里克斯', '波菲洛', '卡蒙', '黛安', '伊莎', '法蘭克', '葛蕾絲', '海克', '艾維'];

client.once('ready', async () => {
  console.log(`✅ 狼人殺Bot已上線：${client.user.tag}`);
  client.user.setActivity('狼人殺 🐺', { type: 0 });
  await registerCommands();
});

function extractChannelId(customId, prefix) {
  return customId.slice(prefix.length);
}

// ── 監聽頻道訊息（輪流發言）──────────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const game = getGame(message.channelId);
  if (!game) return;
  if (game.phase !== GAME_PHASE.DAY) return;
  if (!game._currentSpeaker) return;

  // 非發言者發言 → 刪除並提醒
  if (message.author.id !== game._currentSpeaker.id) {
    try {
      await message.delete();
      const warn = await message.channel.send(
        `<@${message.author.id}> 現在是 **${game._currentSpeaker.displayName}** 的發言時間，請等候！`
      );
      setTimeout(() => warn.delete().catch(() => {}), 4000);
    } catch (_) {}
    return;
  }

  // 是發言者 → 交給 GameEngine 處理
  await handlePlayerSpeak(game, message, message.channel, client);
});

// ── Slash Commands ───────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {

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
      const fields = Object.entries(ROLE_NAMES).map(([role, name]) => ({ name, value: ROLE_DESCRIPTIONS[role], inline: false }));
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x2B2D31).setTitle('📖 狼人殺角色說明').addFields(fields)],
        ephemeral: true,
      });
    }

    if (commandName === 'status') {
      const game = getGame(channelId);
      if (!game) return interaction.reply({ content: '目前沒有進行中的遊戲。', ephemeral: true });
      const phaseMap = { waiting: '等待中', night: '🌙 夜晚', day: '☀️ 白天討論', vote: '🗳️ 投票中', ended: '已結束' };
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x2B2D31).setTitle('🎮 遊戲狀態')
          .addFields(
            { name: '模式', value: game.mode.name, inline: true },
            { name: '階段', value: phaseMap[game.phase] || game.phase, inline: true },
            { name: `第 ${game.day} 天`, value: '\u200b', inline: true },
            { name: '玩家', value: game.formatPlayerList() },
          )],
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
    return;
  }

  // ── Buttons ──────────────────────────────────────────
  if (interaction.isButton()) {
    const { customId, channelId, user } = interaction;
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
          .setDescription('正在建立每位玩家的專屬密室...\n請稍候片刻。')
          .addFields({ name: '玩家列表', value: game.formatPlayerList() })],
        components: [],
      });

      const ch = interaction.channel;
      game.channel = ch;

      await setupThreads(game, ch, client);

      // 通知每位真人玩家角色
      for (const player of game.players.values()) {
        if (!player.isBot) {
          const isWolf = player.role === ROLES.WEREWOLF;
          const threadKey = isWolf ? 'wolf_room' : player.id;
          const thread = game.threads?.get(threadKey);
          if (!thread) continue;
          const wolfAllies = game.aliveWolves.filter(p => p.id !== player.id && !p.isBot);
          let extra = '';
          if (isWolf && wolfAllies.length > 0)
            extra = `\n\n🐺 你的狼人同伴：${wolfAllies.map(p => p.displayName).join(', ')}`;
          try {
            await thread.send({
              content: `<@${player.id}>`,
              embeds: [new EmbedBuilder()
                .setColor(player.team === TEAM.WEREWOLF ? 0x8B0000 : 0x2E8B57)
                .setTitle('🎭 你的角色')
                .setDescription(`**${ROLE_NAMES[player.role]}**\n\n${ROLE_DESCRIPTIONS[player.role]}${extra}${isWolf ? '' : '\n\n⚠️ 夜晚行動指示會在此密室發送，請留意！'}`)]
            });
          } catch (e) { console.error(`角色通知失敗 ${player.username}:`, e.message); }
        }
      }

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
      await registerVote(game, user.id, targetId, game.channel, client);
      return interaction.reply({ content: `✅ 已投票放逐 **${game.getPlayer(targetId)?.displayName || '?'}**`, ephemeral: true });
    }

    // 女巫解藥（密室按鈕）
    if (customId.startsWith('witch_save_yes_') || customId.startsWith('witch_save_no_')) {
      const save = customId.startsWith('witch_save_yes_');
      const gameChannelId = save
        ? extractChannelId(customId, 'witch_save_yes_')
        : extractChannelId(customId, 'witch_save_no_');
      const targetGame = getGame(gameChannelId);
      if (!targetGame) return interaction.update({ embeds: [new EmbedBuilder().setDescription('遊戲已結束。')], components: [] });
      const witch = targetGame.players.get(user.id);
      if (!witch || witch.role !== ROLES.WITCH)
        return interaction.reply({ content: '你不是女巫！', ephemeral: true });
      await interaction.update({ components: [] });
      await completeWitchSave(targetGame, user.id, save, client, targetGame.channel);
      return;
    }

    return;
  }

  // ── Select Menus ─────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const { customId, channelId, user, values } = interaction;
    const selectedId = values[0];

    if (customId.startsWith('wolf_kill_')) {
      const gameChannelId = extractChannelId(customId, 'wolf_kill_');
      const targetGame = getGame(gameChannelId);
      if (!targetGame) return interaction.update({ embeds: [new EmbedBuilder().setDescription('遊戲已結束。')], components: [] });
      const wolf = targetGame.players.get(user.id);
      if (!wolf || wolf.role !== ROLES.WEREWOLF)
        return interaction.reply({ content: '你不是狼人！', ephemeral: true });
      if (targetGame.wolfTarget)
        return interaction.reply({ content: '已有狼人選好目標了！', ephemeral: true });
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x8B0000).setTitle('✅ 目標已選定')
          .setDescription(`今晚將擊殺：**${targetGame.getPlayer(selectedId)?.displayName || '?'}**`)],
        components: [],
      });
      await completeWolfKill(targetGame, selectedId, targetGame.channel, client);
      return;
    }

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
      await completeSeerCheck(targetGame, user.id, selectedId, client, targetGame.channel);
      return;
    }

    if (customId.startsWith('witch_poison_')) {
      const gameChannelId = extractChannelId(customId, 'witch_poison_');
      const targetGame = getGame(gameChannelId);
      if (!targetGame) return interaction.update({ embeds: [new EmbedBuilder().setDescription('遊戲已結束。')], components: [] });
      const witch = targetGame.players.get(user.id);
      if (!witch || witch.role !== ROLES.WITCH)
        return interaction.reply({ content: '你不是女巫！', ephemeral: true });
      await interaction.update({ components: [] });
      await completeWitchPoison(targetGame, user.id, selectedId, client, targetGame.channel);
      return;
    }

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
      await completeHunterShot(targetGame, selectedId, targetGame.channel, client);
      return;
    }

    if (customId === 'vote_select') {
      const game = getGame(channelId);
      if (!game || game.phase !== GAME_PHASE.VOTE)
        return interaction.reply({ content: '現在不是投票時間。', ephemeral: true });
      const voter = game.players.get(user.id);
      if (!voter || !voter.alive)
        return interaction.reply({ content: '你無法投票。', ephemeral: true });
      if (game.voteMap.has(user.id))
        return interaction.reply({ content: '你已投票！', ephemeral: true });
      await registerVote(game, user.id, selectedId, game.channel, client);
      return interaction.reply({ content: `✅ 已投票放逐 **${game.getPlayer(selectedId)?.displayName || '?'}**`, ephemeral: true });
    }

    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
