(function exposeActivityView(root) {
  'use strict';

  function describeActivity(activity, verdict) {
    return {
      label: verdict?.kind === 'distraction' ? 'Off track' : verdict?.kind === 'focus' ? 'On task' : 'Unclear',
      app: activity.app,
      title: activity.title || null,
      url: activity.url || null,
    };
  }

  const api = { describeActivity };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Concentr8ActivityView = api;
})(globalThis);
