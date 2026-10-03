export const notificationKeys = [
  'NOTIFY_JOIN_TEMPLATE_ID', 'NOTIFY_JOIN_MEMBER_KEY', 'NOTIFY_JOIN_TIME_KEY',
  'NOTIFY_REVIEW_TEMPLATE_ID', 'NOTIFY_REVIEW_SUBJECT_KEY', 'NOTIFY_REVIEW_DESCRIPTION_KEY', 'NOTIFY_MINIPROGRAM_STATE'
];

export function productionNotificationConfig(userVariables, jobsVariables, environment = {}) {
  const templateKeys = notificationKeys.slice(0, -1);
  const supplied = templateKeys.filter(key => environment['PRODUCTION_' + key] !== undefined);
  let values;
  if (supplied.length) {
    if (supplied.length !== templateKeys.length) throw new Error('生产订阅消息显式配置不完整');
    values = Object.fromEntries(templateKeys.map(key => [key, String(environment['PRODUCTION_' + key]).trim()]));
    values.NOTIFY_MINIPROGRAM_STATE = 'formal';
  } else {
    const existing = notificationKeys.filter(key => jobsVariables.has(key) || userVariables.has(key));
    if (!existing.length) return {};
    if (existing.length !== notificationKeys.length) throw new Error('生产订阅消息线上配置不完整');
    values = Object.fromEntries(notificationKeys.map(key => {
      if (!jobsVariables.get(key) || jobsVariables.get(key) !== userVariables.get(key)) {
        throw new Error('生产订阅消息两端配置不一致：' + key);
      }
      return [key, jobsVariables.get(key)];
    }));
  }
  if (values.NOTIFY_MINIPROGRAM_STATE !== 'formal') throw new Error('生产订阅消息跳转版本必须是 formal');
  for (const key of templateKeys) {
    const value = values[key];
    if (!value || /REPLACE_WITH|CHANGE_BEFORE_DEPLOY/.test(value)) throw new Error('生产订阅消息配置无效：' + key);
    if (!key.endsWith('TEMPLATE_ID') && !(key === 'NOTIFY_JOIN_TIME_KEY' ? /^time\d+$/ : /^thing\d+$/).test(value)) {
      throw new Error('生产订阅消息字段类型无效：' + key);
    }
  }
  if (values.NOTIFY_JOIN_TEMPLATE_ID === values.NOTIFY_REVIEW_TEMPLATE_ID ||
      values.NOTIFY_REVIEW_SUBJECT_KEY === values.NOTIFY_REVIEW_DESCRIPTION_KEY) {
    throw new Error('生产订阅消息模板或审核字段重复');
  }
  return values;
}
