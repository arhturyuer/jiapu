const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = {
  NOTIFY_JOIN_TEMPLATE_ID: 'join-fixture', NOTIFY_JOIN_MEMBER_KEY: 'thing1', NOTIFY_JOIN_TIME_KEY: 'time2',
  NOTIFY_REVIEW_TEMPLATE_ID: 'review-fixture', NOTIFY_REVIEW_SUBJECT_KEY: 'thing1', NOTIFY_REVIEW_DESCRIPTION_KEY: 'thing4',
  NOTIFY_MINIPROGRAM_STATE: 'formal'
};

test('生产订阅首次配置强制正式版并校验完整性和字段', async () => {
  const { productionNotificationConfig: configure } = await import('../deployment/production-notification-config.mjs');
  const environment = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'NOTIFY_MINIPROGRAM_STATE').map(([key, value]) => ['PRODUCTION_' + key, value]));
  assert.deepEqual(configure(new Map(), new Map(), environment), fixture);
  assert.deepEqual(configure(new Map(), new Map()), {});
  assert.throws(() => configure(new Map(), new Map(), { PRODUCTION_NOTIFY_JOIN_TEMPLATE_ID: 'join' }), /不完整/);
  for (const [key, value] of [['NOTIFY_JOIN_TIME_KEY', 'thing2'], ['NOTIFY_REVIEW_DESCRIPTION_KEY', 'thing1'], ['NOTIFY_REVIEW_TEMPLATE_ID', 'join-fixture'], ['NOTIFY_JOIN_TEMPLATE_ID', '']]) {
    assert.throws(() => configure(new Map(), new Map(), { ...environment, ['PRODUCTION_' + key]: value }));
  }
});

test('生产订阅保留一致线上配置，拒绝部分配置、跨版本及两端差异', async () => {
  const { productionNotificationConfig: configure } = await import('../deployment/production-notification-config.mjs');
  const map = () => new Map(Object.entries(fixture));
  assert.deepEqual(configure(map(), map()), fixture);
  assert.throws(() => configure(map(), new Map()), /不一致/);
  const partial = new Map([['NOTIFY_JOIN_TEMPLATE_ID', 'join-fixture']]);
  assert.throws(() => configure(partial, partial), /不完整/);
  const developer = map(); developer.set('NOTIFY_MINIPROGRAM_STATE', 'developer');
  assert.throws(() => configure(developer, developer), /formal/);
  const mismatch = map(); mismatch.set('NOTIFY_JOIN_TIME_KEY', 'time3');
  assert.throws(() => configure(map(), mismatch), /不一致/);
});
