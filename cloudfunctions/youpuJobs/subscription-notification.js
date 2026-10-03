function templateConfig(env) {
  const values = env || process.env;
  const joinId = String(values.NOTIFY_JOIN_TEMPLATE_ID || '').trim();
  const reviewId = String(values.NOTIFY_REVIEW_TEMPLATE_ID || '').trim();
  const joinMemberKey = String(values.NOTIFY_JOIN_MEMBER_KEY || '').trim();
  const joinTimeKey = String(values.NOTIFY_JOIN_TIME_KEY || '').trim();
  const reviewSubjectKey = String(values.NOTIFY_REVIEW_SUBJECT_KEY || '').trim();
  const reviewDescriptionKey = String(values.NOTIFY_REVIEW_DESCRIPTION_KEY || '').trim();
  const thing = /^thing\d+$/;
  return {
    join: joinId && thing.test(joinMemberKey) && /^time\d+$/.test(joinTimeKey)
      ? { templateId: joinId, memberKey: joinMemberKey, timeKey: joinTimeKey } : null,
    review: reviewId && thing.test(reviewSubjectKey) && thing.test(reviewDescriptionKey) && reviewSubjectKey !== reviewDescriptionKey
      ? { templateId: reviewId, subjectKey: reviewSubjectKey, descriptionKey: reviewDescriptionKey } : null
  };
}

function recipients(notification, memberships) {
  const ids = new Set();
  (memberships || []).forEach(function (membership) {
    if (membership.status !== 'active') return;
    if (membership.role === 'admin' || (notification.notificationType === 'join' && membership.userId === notification.inviterId)) {
      ids.add(membership.userId);
    }
  });
  return Array.from(ids);
}

function messagePayload(notification, family, source, template, user, state) {
  const familyName = String(family.name || '家谱').slice(0, 20);
  const joinedAt = new Date(source.joinedAt || notification.createdAt || Date.now());
  const joinedTime = Number.isNaN(joinedAt.getTime()) ? new Date() : joinedAt;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(joinedTime);
  const data = notification.notificationType === 'join'
    ? {
        [template.memberKey]: { value: String(user.nickName || '家人').slice(0, 20) },
        [template.timeKey]: { value: time }
      }
    : {
        [template.subjectKey]: { value: (familyName + '待审核').slice(0, 20) },
        [template.descriptionKey]: { value: String(source.title || '家谱资料待处理').slice(0, 20) }
      };
  return {
    touser: '',
    templateId: template.templateId,
    page: notification.notificationType === 'join'
      ? 'pages/notification-entry/index?familyId=' + encodeURIComponent(notification.familyId)
      : 'pages/change-list/index?familyId=' + encodeURIComponent(notification.familyId),
    miniprogramState: state,
    lang: 'zh_CN',
    data: data
  };
}

module.exports = { templateConfig: templateConfig, recipients: recipients, messagePayload: messagePayload };
