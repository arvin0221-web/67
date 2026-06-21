// constants.js
export const ROLES = {
  WEREWOLF: 'werewolf',
  VILLAGER: 'villager',
  SEER: 'seer',
  WITCH: 'witch',
  HUNTER: 'hunter',
};

export const ROLE_NAMES = {
  [ROLES.WEREWOLF]: '🐺 狼人',
  [ROLES.VILLAGER]: '👤 平民',
  [ROLES.SEER]: '🔮 預言家',
  [ROLES.WITCH]: '🧙 女巫',
  [ROLES.HUNTER]: '🏹 獵人',
};

export const ROLE_DESCRIPTIONS = {
  [ROLES.WEREWOLF]: '每晚可以殺死一名玩家。目標是消滅所有好人。',
  [ROLES.VILLAGER]: '沒有特殊能力，白天投票找出狼人。',
  [ROLES.SEER]: '每晚可以查驗一名玩家的陣營（好人或狼人）。',
  [ROLES.WITCH]: '擁有一瓶解藥和一瓶毒藥，各只能使用一次。',
  [ROLES.HUNTER]: '死亡時可以開槍帶走一名玩家。',
};

export const TEAM = {
  WEREWOLF: 'werewolf',
  VILLAGER: 'villager',
};

export const ROLE_TEAM = {
  [ROLES.WEREWOLF]: TEAM.WEREWOLF,
  [ROLES.VILLAGER]: TEAM.VILLAGER,
  [ROLES.SEER]: TEAM.VILLAGER,
  [ROLES.WITCH]: TEAM.VILLAGER,
  [ROLES.HUNTER]: TEAM.VILLAGER,
};

// 6人模式：屠城局
export const MODE_6 = {
  name: '6人模式',
  total: 6,
  roles: [
    ROLES.WEREWOLF, ROLES.WEREWOLF,
    ROLES.SEER, ROLES.WITCH,
    ROLES.VILLAGER, ROLES.VILLAGER,
  ],
  winCondition: 'kill_all_specials',
};

// 9人模式：屠邊局
export const MODE_9 = {
  name: '9人模式',
  total: 9,
  roles: [
    ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WEREWOLF,
    ROLES.SEER, ROLES.WITCH, ROLES.HUNTER,
    ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER,
  ],
  winCondition: 'kill_one_side',
};

export const GAME_PHASE = {
  WAITING: 'waiting',
  NIGHT: 'night',
  DAY: 'day',
  VOTE: 'vote',
  ENDED: 'ended',
};

export const EMOJIS = {
  MOON: '🌙',
  SUN: '☀️',
  SKULL: '💀',
  VOTE: '🗳️',
  WOLF: '🐺',
  VILLAGE: '🏘️',
  WIN: '🎉',
};
