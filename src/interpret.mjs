import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const observedAt = text(raw.observedAt, 'observedAt');
           if (!Number.isFinite(Date.parse(observedAt))) throw new Error('观察时间无效');
           const url = new URL(text(raw.url, 'url'));
           return { page: text(raw.page, 'page'), site: text(raw.site, 'site'), url: url.href, observedAt, title: text(raw.title, 'title'), body: text(raw.body, 'body') };
}
