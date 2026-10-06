require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/api');
const ads = require('../miniprogram/utils/ad-access');
const commerce = require('../miniprogram/config/commerce');
const memberQuery = require('./helpers/member-ad-query');

function fixture(t, options) {
  const config = options || {};
  let family = { _id: 'fixture-family', status: 'active', currentRole: 'member', membership: { active: false } };
  const app = {
    globalData: { environment: config.environment || 'staging' },
    getCurrentFamily: function () { return family; },
    applyFamilyUpdate: function (value) { family = value; }
  };
  const page = {
    data: { showMemberSheet: false, memberAdVersion: 0, memberAdReserved: false,
      memberAdMounted: false, memberAdVisible: false, memberAdLoaded: false },
    createSelectorQuery: memberQuery(),
    setData: function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); }
  };
  const previousWx = global.wx;
  const platform = config.platform || 'ios';
  const scope = commerce.memberAdReusePlatforms[app.globalData.environment];
  const previousReuse = Object.assign({}, scope);
  const previousDebug = commerce.memberAdDebugEnabled.staging;
  // 仅计入业务测宽；staging 验收诊断会额外查询原生组件边界。
  commerce.memberAdDebugEnabled.staging = false;
  scope.ios = false;
  scope.android = false;
  scope[platform] = Boolean(config.reuse);
  global.wx = { canIUse: function () { return true; }, nextTick: function (done) { done(); },
    getDeviceInfo: function () { return { platform: platform }; } };
  t.after(function () {
    ads.hide(page, true);
    Object.assign(scope, previousReuse);
    commerce.memberAdDebugEnabled.staging = previousDebug;
    global.wx = previousWx;
  });
  return { app, page };
}

function event(page, offset) {
  return { currentTarget: { dataset: { version: page.data.memberAdVersion + (offset || 0) } } };
}

async function open(page, app) {
  page.data.showMemberSheet = true;
  await ads.openMember(page, app, app.getCurrentFamily());
}

function freeResponse(t, app) {
  let queries = 0;
  t.mock.method(api, 'call', function () { queries += 1; return Promise.resolve({ family: app.getCurrentFamily() }); });
  return function () { return queries; };
}

test('免费确认后预取数据并提前测宽；打开前不创建原生组件，已请求不等于已加载', async function (t) {
  const { app, page } = fixture(t);
  const queries = freeResponse(t, app);
  const steps = [];
  global.wx.preloadAd = function (units) {
    assert.deepEqual(units, [{ unitId: 'adunit-f0e7fed2bde51c0c', type: 'custom' }]);
    steps.push('preload');
  };
  page.createSelectorQuery = memberQuery(function (selector) {
    assert.equal(selector, '.member-sheet-ad-measure-slot');
    assert.equal(page.data.showMemberSheet, false);
    assert.equal(page.data.memberAdMounted, false);
    steps.push('measure');
    return { width: 381.333 };
  });
  await ads.preloadMember(page, app, app.getCurrentFamily());
  assert.deepEqual(steps, ['preload', 'measure']);
  assert.equal(page.data.memberAdWidth, 381.33);
  assert.equal(page._memberAdCache.dataPreloadState, 'requested');
  assert.equal(page.data.memberAdMounted, false);
  assert.equal(page.data.memberAdReserved, false);
  assert.equal(page.data.memberAdLoaded, false);
  await open(page, app);
  assert.equal(queries(), 1);
  assert.deepEqual(steps, ['preload', 'measure'], '打开使用已提交宽度，不再测量');
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(page.data.memberAdVisible, true);
  assert.equal(page.data.memberAdLoaded, false);
  ads.loaded(page, true, event(page));
  assert.equal(page.data.memberAdLoaded, true);
});

test('顶部与人物广告共享并发权益查询，免费或会员响应更新仍能被两个入口接收', async function (t) {
  const { app, page } = fixture(t);
  const initial = app.getCurrentFamily();
  for (const membership of [{ active: false }, { active: true, lifetime: true }]) {
    ads.hide(page, true);
    app.applyFamilyUpdate(initial);
    let resolve;
    let queries = 0;
    t.mock.method(api, 'call', function () { queries += 1; return new Promise(function (yes) { resolve = yes; }); });
    const top = ads.refresh(page, app, 'treeTop', initial);
    const member = ads.preloadMember(page, app, initial);
    assert.equal(queries, 1);
    resolve({ family: Object.assign({}, initial, { membership: membership }) });
    await Promise.all([top, member]);
    assert.equal(page.data.topAdVisible, membership.active === false);
    await open(page, app);
    assert.equal(page.data.memberAdReserved, membership.active === false);
    assert.equal(queries, 1);
    page.data.showMemberSheet = false;
  }
});

test('所有角色共享家庭会员免广告；未知、冻结、无权限及错误权益均不显示模块或预加载', async function (t) {
  const { app, page } = fixture(t);
  const free = app.getCurrentFamily();
  let response;
  let preloads = 0;
  global.wx.preloadAd = function () { preloads += 1; };
  t.mock.method(api, 'call', function () { return response instanceof Error ? Promise.reject(response) : Promise.resolve(response); });
  for (const environment of ['staging', 'production']) {
    app.globalData.environment = environment;
    for (const role of ['admin', 'member', 'viewer']) {
      for (const membership of [{ active: true, lifetime: true }, { active: true, expiresAt: '2999-01-01' }, {}]) {
        ads.hide(page, true);
        app.applyFamilyUpdate(free);
        response = { family: Object.assign({}, free, { currentRole: role, membership: membership }) };
        await open(page, app);
        assert.equal(page.data.memberAdReserved, false);
        assert.equal(page.data.memberAdMounted, false);
      }
    }
  }
  app.globalData.environment = 'staging';
  for (const value of [{}, { family: { _id: 'other' } }, new Error('fixture denied'),
    { family: Object.assign({}, free, { status: 'frozen' }) }]) {
    ads.hide(page, true);
    app.applyFamilyUpdate(free);
    response = value;
    await open(page, app);
    assert.equal(page.data.memberAdReserved, false);
    assert.equal(page.data.memberAdMounted, false);
  }
  assert.equal(preloads, 0);
  response = { family: free };
  app.applyFamilyUpdate(free);
  await open(page, app);
  assert.equal(page.data.memberAdMounted, true);
});

test('权益请求中立即打开弹框但不预留广告模块；关闭后的迟到免费结果仅准备数据和宽度', async function (t) {
  const { app, page } = fixture(t);
  let resolve;
  let calls = 0;
  t.mock.method(api, 'call', function () { calls += 1; return new Promise(function (yes) { resolve = yes; }); });
  const preparing = ads.preloadMember(page, app, app.getCurrentFamily());
  page.data.showMemberSheet = true;
  const opening = ads.openMember(page, app, app.getCurrentFamily());
  assert.equal(page.data.memberAdReserved, false);
  assert.equal(calls, 1);
  ads.closeMember(page);
  page.data.showMemberSheet = false;
  resolve({ family: app.getCurrentFamily() });
  await Promise.all([preparing, opening]);
  assert.equal(page.data.memberAdWidth, 320);
  assert.equal(page.data.memberAdMounted, false);
  assert.equal(page.data.memberAdReserved, false);
  await open(page, app);
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(calls, 1);
});

test('通过平台验证时普通关闭保留组件、就绪状态及版本，再次打开不查询或重新测宽', async function (t) {
  const { app, page } = fixture(t, { reuse: true });
  const queries = freeResponse(t, app);
  await ads.preloadMember(page, app, app.getCurrentFamily());
  await open(page, app);
  const old = event(page);
  ads.loaded(page, true, old);
  ads.closeMember(page);
  page.data.showMemberSheet = false;
  assert.equal(page.data.memberAdVisible, false);
  assert.equal(page.data.memberAdReserved, false);
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(page.data.memberAdLoaded, true);
  assert.equal(page.data.memberAdVersion, old.currentTarget.dataset.version);
  await open(page, app);
  assert.equal(queries(), 1);
  assert.equal(page.data.memberAdLoaded, true);
  assert.equal(page.data.memberAdVersion, old.currentTarget.dataset.version);
});

test('保留的组件关闭后迟到加载只更新缓存；模块自定义关闭仅影响本次弹框', async function (t) {
  const { app, page } = fixture(t, { reuse: true });
  const queries = freeResponse(t, app);
  await open(page, app);
  const old = event(page);
  ads.dismissMember(page);
  assert.equal(page.data.memberAdMounted, true);
  ads.loaded(page, true, old);
  assert.equal(page.data.memberAdLoaded, true);
  assert.equal(page.data.memberAdVisible, false);
  assert.equal(page.data.memberAdReserved, false);
  await open(page, app);
  assert.equal(page.data.memberAdVisible, true);
  assert.equal(page.data.memberAdLoaded, true);
  assert.equal(queries(), 1);
});

test('关闭复用的平台和设备信息异常采用销毁兜底并隔离旧事件', async function (t) {
  const { app, page } = fixture(t);
  const queries = freeResponse(t, app);
  for (const platform of ['ios', 'android', 'devtools', 'unknown']) {
    global.wx.getDeviceInfo = function () { return { platform: platform }; };
    await open(page, app);
    const old = event(page);
    ads.loaded(page, true, old);
    ads.closeMember(page);
    page.data.showMemberSheet = false;
    ads.loaded(page, true, old);
    ads.error(page, true, old);
    assert.equal(page.data.memberAdMounted, false);
    assert.equal(page.data.memberAdLoaded, false);
    assert.ok(page.data.memberAdVersion > old.currentTarget.dataset.version);
    assert.equal(page.data.memberAdWidth, 320);
  }
  assert.equal(queries(), 1);
  global.wx.getDeviceInfo = function () { throw new Error('fixture unavailable'); };
  await open(page, app);
  ads.closeMember(page);
  assert.equal(page.data.memberAdMounted, false);
  app.globalData.environment = 'unknown';
  await open(page, app);
  assert.equal(page.data.memberAdReserved, false);
  assert.equal(queries(), 1);
});

test('广告错误和原生关闭保留免费模块文案，同次窗口变化不重试，下次打开重试一次', async function (t) {
  const { app, page } = fixture(t);
  const queries = freeResponse(t, app);
  await open(page, app);
  const old = event(page);
  ads.error(page, true, old);
  assert.equal(page.data.memberAdMounted, false);
  assert.equal(page.data.memberAdReserved, true);
  assert.equal(page.data.memberAdLoaded, false);
  assert.equal(page.data.memberAdPreloadState, 'failed');
  await ads.resizeMember(page, app);
  assert.equal(page.data.memberAdMounted, false);
  ads.loaded(page, true, old);
  assert.equal(page.data.memberAdLoaded, false);
  await open(page, app);
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(queries(), 1);
  ads.error(page, true, old);
  assert.equal(page.data.memberAdMounted, true, '旧错误不能清理新组件');
});

test('10秒加载超时清理失败实例，隐藏实例也超时；成功加载清除超时', async function (t) {
  const { app, page } = fixture(t, { reuse: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  freeResponse(t, app);
  await open(page, app);
  t.mock.timers.tick(9999);
  assert.equal(page.data.memberAdMounted, true);
  t.mock.timers.tick(1);
  assert.equal(page.data.memberAdMounted, false);
  assert.equal(page.data.memberAdReserved, true);
  assert.equal(page.data.memberAdPreloadState, 'failed');
  await open(page, app);
  ads.closeMember(page);
  page.data.showMemberSheet = false;
  t.mock.timers.tick(10000);
  assert.equal(page.data.memberAdMounted, false);
  assert.equal(page.data.memberAdReserved, false);
  await open(page, app);
  ads.loaded(page, true, event(page));
  t.mock.timers.tick(10000);
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(page.data.memberAdLoaded, true);
});

test('提前测宽零值下一帧重试；最终失败保留文案，下次打开再测且不重复查权益', async function (t) {
  const { app, page } = fixture(t);
  const queries = freeResponse(t, app);
  let measures = 0;
  page.createSelectorQuery = memberQuery(function () { measures += 1; return { width: measures > 2 ? 355 : 0 }; });
  await open(page, app);
  assert.equal(measures, 2);
  assert.equal(page.data.memberAdMounted, false);
  assert.equal(page.data.memberAdReserved, true);
  await open(page, app);
  assert.equal(page.data.memberAdWidth, 355);
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(queries(), 1);
});

test('同宽尺寸重测复用；关闭期间宽度改变销毁旧实例并提前准备，重开不再测量', async function (t) {
  const { app, page } = fixture(t, { reuse: true });
  const queries = freeResponse(t, app);
  let width = 320;
  let measures = 0;
  page.createSelectorQuery = memberQuery(function () { measures += 1; return { width: width }; });
  await open(page, app);
  const old = event(page);
  ads.loaded(page, true, old);
  await ads.resizeMember(page, app);
  assert.equal(page.data.memberAdVersion, old.currentTarget.dataset.version);
  assert.equal(page.data.memberAdLoaded, true);
  ads.closeMember(page);
  page.data.showMemberSheet = false;
  width = 458.5;
  await ads.resizeMember(page, app);
  assert.equal(page.data.memberAdWidth, 458.5);
  assert.equal(page.data.memberAdMounted, false);
  const count = measures;
  await open(page, app);
  assert.equal(measures, count);
  ads.loaded(page, true, old);
  ads.error(page, true, old);
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(page.data.memberAdLoaded, false);
  assert.equal(queries(), 1);
});

test('提交宽度视图期间关闭不会创建广告，迟到提交保留已测宽度供下次打开', async function (t) {
  const { app, page } = fixture(t);
  const queries = freeResponse(t, app);
  let finish;
  let notify;
  const measured = new Promise(function (resolve) { notify = resolve; });
  page.setData = function (patch, callback) {
    Object.assign(this.data, patch);
    if (patch.memberAdWidth > 0) { finish = callback; notify(); }
    else if (callback) callback();
  };
  const pending = open(page, app);
  await measured;
  ads.closeMember(page);
  page.data.showMemberSheet = false;
  finish();
  await pending;
  assert.equal(page.data.memberAdMounted, false);
  await open(page, app);
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(queries(), 1);
});

test('同页沿用已确认权益；重新进入清理缓存并确认新会员状态', async function (t) {
  const { app, page } = fixture(t, { reuse: true });
  let response = app.getCurrentFamily();
  let queries = 0;
  t.mock.method(api, 'call', function () { queries += 1; return Promise.resolve({ family: response }); });
  await open(page, app);
  response = Object.assign({}, response, { membership: { active: true, lifetime: true } });
  ads.closeMember(page);
  await open(page, app);
  assert.equal(queries, 1);
  assert.equal(page.data.memberAdReserved, true);
  ads.hide(page, true);
  page.data.showMemberSheet = false;
  await ads.preloadMember(page, app, app.getCurrentFamily());
  await open(page, app);
  assert.equal(queries, 2);
  assert.equal(page.data.memberAdMounted, false);
  assert.equal(page.data.memberAdReserved, false);
});

test('会员到期先重新确认，确认免费前保持无模块；永久会员不设置到期计时器', async function (t) {
  const { app, page } = fixture(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: now });
  const member = Object.assign({}, app.getCurrentFamily(), { membership: { active: true, expiresAt: new Date(now + 1000).toISOString() } });
  let resolve;
  let queries = 0;
  t.mock.method(api, 'call', function () {
    queries += 1;
    if (queries === 1) return Promise.resolve({ family: member });
    return new Promise(function (yes) { resolve = yes; });
  });
  await open(page, app);
  assert.equal(page.data.memberAdReserved, false);
  t.mock.timers.tick(1000);
  assert.equal(queries, 2);
  assert.equal(page.data.memberAdReserved, false);
  resolve({ family: Object.assign({}, member, { membership: { active: false } }) });
  await page._memberAdCache.promise;
  assert.equal(page.data.memberAdMounted, true);
  ads.hide(page, true);
  t.mock.method(api, 'call', function () { return Promise.resolve({ family: Object.assign({}, member, { membership: { active: true, lifetime: true } }) }); });
  await ads.preloadMember(page, app, app.getCurrentFamily());
  assert.equal(page._memberAdCache.expiryTimer, undefined);
});

test('切谱、离页、卸载、环境、账号和期间获得会员使旧权益结果与预加载失效', async function (t) {
  const { app, page } = fixture(t);
  const family = app.getCurrentFamily();
  let resolve;
  let preloads = 0;
  global.wx.preloadAd = function () { preloads += 1; };
  t.mock.method(api, 'call', function () { return new Promise(function (yes) { resolve = yes; }); });
  for (const invalidate of [
    function () { app.applyFamilyUpdate(Object.assign({}, family, { _id: 'other' })); },
    function () { page._adPageHidden = true; ads.hide(page, true); },
    function () { page._unloaded = true; ads.hide(page, true); },
    function () { app.globalData.environment = 'production'; },
    function () { app.globalData.accountState = 'pending_delete'; },
    function () { app.applyFamilyUpdate(Object.assign({}, family, { membership: { active: true, lifetime: true } })); }
  ]) {
    ads.hide(page, true);
    app.applyFamilyUpdate(family);
    page._adPageHidden = false; page._unloaded = false;
    app.globalData.environment = 'staging'; app.globalData.accountState = 'active';
    const pending = ads.preloadMember(page, app, family);
    invalidate();
    resolve({ family: family });
    await pending;
    assert.equal(page.data.memberAdMounted, false);
    assert.equal(page.data.memberAdReserved, false);
  }
  assert.equal(preloads, 0);
});

test('SDK按应用广告位去重，切谱和重新进入重查权益；预加载不支持或失败仍可见后加载', async function (t) {
  const { app, page } = fixture(t);
  const queries = freeResponse(t, app);
  let preloads = 0;
  global.wx.preloadAd = function () { preloads += 1; };
  await ads.preloadMember(page, app, app.getCurrentFamily());
  ads.hide(page, true);
  await ads.preloadMember(page, app, app.getCurrentFamily());
  app.applyFamilyUpdate(Object.assign({}, app.getCurrentFamily(), { _id: 'next-family' }));
  await ads.preloadMember(page, app, app.getCurrentFamily());
  assert.equal(preloads, 1);
  assert.equal(queries(), 3);
  delete global.wx.preloadAd;
  await ads.preloadMember(page, app, app.getCurrentFamily(), true);
  assert.equal(page._memberAdCache.dataPreloadState, 'unsupported');
  await open(page, app);
  assert.equal(page.data.memberAdMounted, true);
  app._memberAdPreloadUnits.clear();
  global.wx.preloadAd = function () { throw new Error('fixture API failed'); };
  await ads.preloadMember(page, app, app.getCurrentFamily(), true);
  assert.equal(page._memberAdCache.dataPreloadState, 'failed');
  assert.equal(page.data.memberAdMounted, true);
  assert.equal(page.data.memberAdLoaded, false);
});

test('会员入口在免费广告加载期间可用，跳转时清理保留实例；切谱后旧入口不可购买', async function (t) {
  const { app, page } = fixture(t, { reuse: true });
  freeResponse(t, app);
  const visits = [];
  global.wx.navigateTo = function (options) { visits.push(options.url); };
  await open(page, app);
  const family = app.getCurrentFamily();
  app.applyFamilyUpdate(Object.assign({}, family, { _id: 'other' }));
  ads.openMembership(page, app, true);
  assert.equal(visits.length, 0);
  app.applyFamilyUpdate(family);
  ads.openMembership(page, app, true);
  assert.deepEqual(visits, ['/pages/membership/index?familyId=fixture-family']);
  assert.equal(page.data.showMemberSheet, false);
  assert.equal(page.data.memberAdMounted, false);
});

test('旧测量在切谱或新一轮尺寸变更后不可提交；错误中断测量且不能复活广告', async function (t) {
  const { app, page } = fixture(t);
  freeResponse(t, app);
  await open(page, app);
  const old = event(page);
  const answers = [];
  let notify;
  page.createSelectorQuery = function () {
    const query = { select: function () { return query; }, boundingClientRect: function () { return query; },
      exec: function (callback) { answers.push(callback); notify(); } };
    return query;
  };
  let measured = new Promise(function (resolve) { notify = resolve; });
  const first = ads.resizeMember(page, app);
  await measured;
  measured = new Promise(function (resolve) { notify = resolve; });
  const second = ads.resizeMember(page, app);
  await measured;
  answers.shift()([{ width: 450 }]);
  ads.error(page, true, old);
  answers.shift()([{ width: 500 }]);
  await Promise.all([first, second]);
  assert.equal(page.data.memberAdWidth, 320);
  assert.equal(page.data.memberAdMounted, false);
  assert.equal(page.data.memberAdReserved, true);
});


for (const environment of ['staging', 'production']) {
  for (const platform of ['ios', 'android']) {
    test(environment + ' ' + platform + ' 免费家谱关闭后复用，关闭平台开关后可销毁兜底', async function (t) {
      const { app, page } = fixture(t, { reuse: true, platform: platform, environment: environment });
      const queries = freeResponse(t, app);
      await open(page, app);
      const version = page.data.memberAdVersion;
      ads.loaded(page, true, event(page));
      ads.closeMember(page);
      page.data.showMemberSheet = false;
      assert.equal(page.data.memberAdMounted, true);
      assert.equal(page.data.memberAdLoaded, true);
      assert.equal(page.data.memberAdVisible, false);
      await open(page, app);
      assert.equal(page.data.memberAdVersion, version);
      assert.equal(page.data.memberAdLoaded, true);
      assert.equal(page.data.memberAdVisible, true);
      assert.equal(queries(), 1);
      commerce.memberAdReusePlatforms[environment][platform] = false;
      ads.closeMember(page);
      assert.equal(page.data.memberAdMounted, false);
    });
  }
}

test('权益请求期间本地已变为会员时，顶部与人物广告都不应用旧免费响应', async function (t) {
  const { app, page } = fixture(t);
  const family = app.getCurrentFamily();
  let resolve;
  t.mock.method(api, 'call', function () { return new Promise(function (yes) { resolve = yes; }); });
  const top = ads.refresh(page, app, 'treeTop', family);
  const member = ads.preloadMember(page, app, family);
  app.applyFamilyUpdate(Object.assign({}, family, { membership: { active: true, lifetime: true } }));
  resolve({ family: family });
  await Promise.all([top, member]);
  assert.equal(page.data.topAdVisible, false);
  assert.equal(page.data.memberAdReserved, false);
  assert.equal(app.getCurrentFamily().membership.lifetime, true);
});

test('重查期间旧请求拒绝不破坏新缓存，切谱的旧测量不能提交到新家谱', async function (t) {
  const { app, page } = fixture(t);
  const pending = [];
  t.mock.method(api, 'call', function () { return new Promise(function (resolve, reject) { pending.push({ resolve, reject }); }); });
  const old = ads.preloadMember(page, app, app.getCurrentFamily());
  ads.hide(page, true);
  const fresh = ads.preloadMember(page, app, app.getCurrentFamily());
  pending.shift().reject(new Error('fixture old request failure'));
  await old;
  assert.equal(page.data.memberAdPreloadState, 'checking');
  pending.shift().resolve({ family: app.getCurrentFamily() });
  await fresh;
  let answer;
  let notify;
  const measured = new Promise(function (resolve) { notify = resolve; });
  page.createSelectorQuery = function () {
    const query = { select: function () { return query; }, boundingClientRect: function () { return query; },
      exec: function (callback) { answer = callback; notify(); } };
    return query;
  };
  const sizing = ads.resizeMember(page, app);
  await measured;
  app.applyFamilyUpdate(Object.assign({}, app.getCurrentFamily(), { _id: 'new-family' }));
  answer([{ width: 450 }]);
  await sizing;
  assert.equal(page.data.memberAdWidth, 0);
  assert.equal(page.data.memberAdMounted, false);
});

test('长于定时器上限的会员期限分段等待，到期前不额外查询，到期时重新确认', async function (t) {
  const { app, page } = fixture(t);
  const now = Date.now();
  const maximumDelay = 2147483647;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: now });
  const member = Object.assign({}, app.getCurrentFamily(), {
    membership: { active: true, expiresAt: new Date(now + maximumDelay + 1000).toISOString() }
  });
  let queries = 0;
  t.mock.method(api, 'call', function () {
    queries += 1;
    return Promise.resolve({ family: queries === 1 ? member : Object.assign({}, member, { membership: { active: false } }) });
  });
  await ads.preloadMember(page, app, app.getCurrentFamily());
  t.mock.timers.tick(maximumDelay);
  assert.equal(queries, 1);
  t.mock.timers.tick(999);
  assert.equal(queries, 1);
  t.mock.timers.tick(1);
  await page._memberAdCache.promise;
  assert.equal(queries, 2);
  assert.equal(page._memberAdCache.canDisplay, true);
  assert.equal(page.data.memberAdMounted, false);
});
