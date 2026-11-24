// 本地合作归档站：按订单时点协商历史观察，按版本提供附表。
// 仅绑定回环地址，供测试与演示独立复查，不连接真实归档方。
export function archiveStation(archive) {
  if (!archive || typeof archive !== 'object') throw new Error('归档夹具无效');
  const identity = archive.identity;
  const basePath = archive.basePath;
  const within = (bounds, moment) => Date.parse(bounds[0]) <= Date.parse(moment) && Date.parse(moment) < Date.parse(bounds[1]);
  const handler = ({ query }) => {
    const page = query.page;
    if (!page) return { status: 400, body: { error: '缺少页面身份' } };
    if (query.edition) {
      const edition = archive.editions?.[page]?.[query.edition];
      if (!edition) return { status: 404, body: { error: '归档缺档' } };
      return {
        status: 200,
        body: { page, site: edition.record.site, source: identity, edition: query.edition, observedAt: edition.observedAt, record: edition.record },
      };
    }
    if (query.at) {
      const versions = (archive.versions?.[page] ?? []).filter((version) => within(version.period, query.at));
      if (versions.length === 0) return { status: 404, body: { error: '订单周期内无观察' } };
      const ordered = [...versions].sort(
        (a, b) => Math.abs(Date.parse(a.observedAt) - Date.parse(query.at)) - Math.abs(Date.parse(b.observedAt) - Date.parse(query.at)),
      );
      const [chosen, ...rest] = ordered;
      return {
        status: 200,
        body: {
          page,
          site: chosen.record.site,
          source: identity,
          observedAt: chosen.observedAt,
          period: chosen.period,
          record: chosen.record,
          references: chosen.references ?? [],
          withheld: rest.map((version) => ({ observedAt: version.observedAt })),
        },
      };
    }
    return { status: 400, body: { error: '缺少时点或版本参数' } };
  };
  return { [basePath]: handler };
}

export function archiveHandlers(fixture) {
  const handlers = {};
  for (const archive of Object.values(fixture.archives ?? {})) Object.assign(handlers, archiveStation(archive));
  return handlers;
}
