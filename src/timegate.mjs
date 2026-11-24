import { interpretObservation, interpretEdition } from './historical.mjs';

// 合作归档站的时点协商：按订单时点请求历史观察，按版本请求附表。
// 客户端不跟随重定向：站点迁移后的当前重定向不构成历史身份依据。
export async function negotiate(client, archivePath, page, at) {
  const query = new URLSearchParams({ page, at });
  const document = await client.get(archivePath + '?' + query.toString());
  return { document, observation: interpretObservation(document.raw) };
}

export async function negotiateEdition(client, archivePath, page, edition) {
  const query = new URLSearchParams({ page, edition });
  const document = await client.get(archivePath + '?' + query.toString());
  return { document, edition: interpretEdition(document.raw) };
}
