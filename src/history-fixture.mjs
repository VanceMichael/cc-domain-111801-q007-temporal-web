// 构造可独立复查的本地历史归档合作源夹具：
// - 每个归档来源提供一个 timegate，按 url/at(/edition) 协商；
// - 周期内若存在多版正文，候选清单全部列出，但 location 只给较近一版；
// - 附表按 page+edition 钉版，持有的版本不同或缺档时明确拒绝，不用近版顶替；
// - 可注入重定向资源，验证当前重定向不被当作历史身份依据。
export function historySourceFixture(options = {}) {
  const {
    scope = 'shop-a',
    page = 'PAGE1',
    pageUrl = 'https://shop.invalid/terms',
    cycles = [],
    archives = [{ source: 'archive-a', gate: '/archive/a/gate' }],
    bodyHolds = {},
    zoneHolds = {},
    bodyRedirect = null,
  } = options;

  const resources = {};
  resources['/web/current'] = {
    body: { site: scope, pages: [{ id: page, href: '/web/current/records/' + page }] },
  };
  resources['/web/current/records/' + page] = {
    body: {
      page, site: scope, url: pageUrl,
      observedAt: '2026-11-19T00:00:00Z',
      title: '运输说明（当前页）',
      body: '本地区运费以订单确认页为准',
    },
  };
  resources['/web/current/relations/' + page] = {
    body: {
      periods: cycles.map(({ start, end }) => ({ start, end })),
      archives: archives.map(({ source, gate }) => ({ source, timegate: gate })),
      references: [{ page: 'zones', edition: options.zoneEdition ?? 'v4' }],
    },
  };

  const parseAt = query => {
    const at = Date.parse(query.at);
    if (!Number.isFinite(at)) return null;
    return at;
  };
  const cycleOf = at => cycles.find(({ start, end }) => {
    const left = Date.parse(start + 'T00:00:00Z');
    const right = Date.parse(end + 'T00:00:00Z');
    return at >= left && at < right;
  });

  for (const archive of archives) {
    const holds = bodyHolds[archive.source] ?? [];
    const zones = zoneHolds[archive.source] ?? [];
    const gate = request => {
      const query = request.query;
      const at = parseAt(query);
      if (at === null || !query.url) {
        return { status: 400, body: { error: '协商参数无效' } };
      }
      const cycle = cycleOf(at);
      if (!cycle) return { status: 404, body: { error: '该时点没有可用观察' } };
      const inCycle = hold => {
        const observed = Date.parse(hold.observedAt);
        return observed >= Date.parse(cycle.start + 'T00:00:00Z')
          && observed < Date.parse(cycle.end + 'T00:00:00Z');
      };

      if (query.edition) {
        if (query.url.endsWith('/zones')) {
          const match = zones.find(hold => hold.edition === query.edition && inCycle(hold));
          if (!match) return { status: 404, body: { error: '该附表版本无观察' } };
          const location = '/archive/' + archive.source + '/memento/zones/' + match.observedAt;
          return {
            body: {
              source: archive.source, location,
              candidates: zones.filter(inCycle).map(hold => ({ observedAt: hold.observedAt, edition: hold.edition })),
            },
          };
        }
        return { status: 404, body: { error: '该版本无观察' } };
      }

      if (query.url === pageUrl) {
        const within = holds.filter(inCycle).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
        if (within.length === 0) return { status: 404, body: { error: '该周期没有正文观察' } };
        const nearest = within[within.length - 1];
        if (bodyRedirect && archive.source === bodyRedirect.source && inCycle(nearest)) {
          return { status: 302, headers: { location: bodyRedirect.location }, body: {} };
        }
        const location = '/archive/' + archive.source + '/memento/body/' + nearest.observedAt;
        return {
          body: {
            source: archive.source, location,
            candidates: within.map(hold => ({ observedAt: hold.observedAt })),
          },
        };
      }
      return { status: 404, body: { error: '未知协商目标' } };
    };
    resources[archive.gate] = gate;

    for (const hold of holds) {
      const path = '/archive/' + archive.source + '/memento/body/' + hold.observedAt;
      resources[path] = {
        body: {
          page, site: scope, url: pageUrl,
          observedAt: hold.observedAt,
          title: hold.title ?? '运输说明（历史观察）',
          body: hold.body,
        },
      };
    }
    for (const hold of zones) {
      const path = '/archive/' + archive.source + '/memento/zones/' + hold.observedAt;
      resources[path] = {
        body: {
          page: 'zones', site: scope,
          url: new URL('zones', pageUrl).href,
          observedAt: hold.observedAt,
          edition: hold.edition,
          title: '地区运费附表 ' + hold.edition,
          body: hold.body,
        },
      };
    }
  }

  return { scope, page, resources, pageUrl };
}
