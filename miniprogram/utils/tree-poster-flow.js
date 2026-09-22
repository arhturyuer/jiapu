const api = require('./api');
const graphLayout = require('./graph-layout');
const kinship = require('./kinship');
const posterSession = require('./poster-session');
const treePoster = require('./tree-poster');

function cancel(page) {
  page._posterGenerationSequence = (page._posterGenerationSequence || 0) + 1;
  if (page.data.posterGenerating) page.setData({ posterGenerating: false });
}

function generate(page, options) {
  const value = options || {};
  if (page.data.posterGenerating || !page.data.rawPersons || !page.data.rawPersons.length) return;
  const sequence = (page._posterGenerationSequence || 0) + 1;
  page._posterGenerationSequence = sequence;
  page.setData({ posterGenerating: true });

  let kinshipDetails = {};
  if (page.data.viewMode === 'perspective') {
    if (!page._kinshipCache) page._kinshipCache = kinship.createKinshipCache();
    kinshipDetails = page._kinshipCache(page.data.rawPersons, page.data.rawRelations, page.data.viewpointId);
  }
  const layout = graphLayout.layoutGraph(page.data.rawPersons, page.data.rawRelations, {
    mode: page.data.viewMode,
    viewpointId: page.data.viewpointId,
    nameLayout: page.data.nameLayout,
    collapsedIds: page.data.collapsedPersonIds,
    selectedPersonId: '',
    kinshipDetails: kinshipDetails
  });

  Promise.resolve().then(function () {
    return value.prepareCode();
  }).then(function (code) {
    if (sequence !== page._posterGenerationSequence) return null;
    if (value.onPrepared) value.onPrepared(code);
    return treePoster.render(page, value.canvasId, layout, {
      familyName: value.familyName,
      viewMode: page.data.viewMode,
      viewLabel: page.data.viewMode === 'perspective'
        ? '当前视图：从「' + page.data.viewpointName + '」看家谱'
        : '当前视图：完整家谱',
      showChildRankBadge: page.data.showChildRankBadge,
      showGenderBadge: page.data.showGenderBadge,
      showGenderColors: page.data.showGenderColors,
      miniCodePath: code.miniCodePath
    }).then(function (poster) {
      return { code: code, poster: poster };
    });
  }).then(function (result) {
    if (!result || sequence !== page._posterGenerationSequence) return;
    posterSession.set({
      filePath: result.poster.filePath,
      familyName: value.familyName,
      sharePayload: value.sharePayload ? value.sharePayload(result.code) : null
    });
    wx.navigateTo({
      url: '/pages/poster-preview/index',
      fail: function () {
        posterSession.clear();
        wx.showToast({ title: '图片预览打开失败，请重试', icon: 'none' });
      }
    });
  }).catch(function (error) {
    if (sequence !== page._posterGenerationSequence) return;
    wx.showToast({
      title: error && error.code === 'POSTER_TOO_LARGE'
        ? '当前展开内容过多，请先收起部分分支'
        : api.userMessage(error, '图片生成失败，请稍后重试'),
      icon: 'none',
      duration: 3000
    });
  }).then(function () {
    if (sequence === page._posterGenerationSequence) page.setData({ posterGenerating: false });
  });
}

module.exports = {
  cancel: cancel,
  generate: generate
};
