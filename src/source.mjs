import { text } from './validation.mjs';

export const collectionPath = "/web/current";
export function relationsPath(identity) {
  return collectionPath + '/relations/' + encodeURIComponent(identity);
}
export async function browse(client) {
  const document = await client.get(collectionPath);
  const raw = document.raw;
  const context = text(raw.site, "site");
  if (!Array.isArray(raw.pages)) throw new Error('来源目录结构无效');
  const references = raw.pages.map(entry => ({
    identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context,
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  return { context, references };
}
export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.page !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.site !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}
export async function retrieveRelations(client, identity) {
  const document = await client.get(relationsPath(identity));
  // 关联资料是来源对发布周期、归档位置与引用关系的原始声明，交由领域层解释。
  if (!document.raw || typeof document.raw !== 'object' || Array.isArray(document.raw)) {
    throw new Error('关联资料结构无效');
  }
  return document.raw;
}
