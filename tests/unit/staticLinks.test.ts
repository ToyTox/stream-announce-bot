import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db.js';
import { MAX_LINK_LABEL, MAX_LINK_URL, MAX_STATIC_LINKS, StaticLinksError, Store } from '../../src/store.js';

let dir: string;
let db: Db;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stream-bot-links-'));
  db = openDb(join(dir, 'bot.db'));
  store = new Store(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const kick = { label: 'Kick', url: 'https://kick.com/me', always: true };
const boosty = { label: 'Boosty', url: 'https://boosty.to/me', always: false };

describe('статические ссылки: хранение', () => {
  it('по умолчанию список пуст', () => {
    expect(store.staticLinks()).toEqual([]);
    expect(store.alwaysLinks()).toEqual([]);
  });

  it('сохраняет и читает список в заданном порядке', () => {
    store.setStaticLinks([boosty, kick]);

    expect(store.staticLinks()).toEqual([boosty, kick]);
    expect(store.alwaysLinks()).toEqual([kick]);
  });

  it('замена списка целиком, пустой список сбрасывает; пробелы обрезаются, отметка по умолчанию выключена', () => {
    store.setStaticLinks([kick]);
    store.setStaticLinks([{ label: '  Boosty ', url: ' https://boosty.to/me ' }]);

    expect(store.staticLinks()).toEqual([boosty]);

    store.setStaticLinks([]);

    expect(store.staticLinks()).toEqual([]);
  });

  it('битая запись в базе читается как пустой список', () => {
    store.setSetting('static_links', '{не json');

    expect(store.staticLinks()).toEqual([]);
  });
});

describe('статические ссылки: проверка', () => {
  const bad: Array<[string, unknown]> = [
    ['не массив', { label: 'x' }],
    ['элемент не объект', [null]],
    ['пустое название', [{ label: '   ', url: 'https://a.example' }]],
    ['слишком длинное название', [{ label: 'x'.repeat(MAX_LINK_LABEL + 1), url: 'https://a.example' }]],
    ['слишком длинный адрес', [{ label: 'x', url: `https://a.example/${'x'.repeat(MAX_LINK_URL)}` }]],
    ['относительный адрес', [{ label: 'x', url: '/kick' }]],
    ['адрес без схемы', [{ label: 'x', url: 'kick.com/me' }]],
    ['javascript:', [{ label: 'x', url: 'javascript:alert(1)' }]],
    ['ftp', [{ label: 'x', url: 'ftp://a.example/file' }]],
    ['пробел в адресе', [{ label: 'x', url: 'https://a.example/a b' }]],
    ['отметка не булева', [{ label: 'x', url: 'https://a.example', always: 'yes' }]],
    ['слишком много ссылок', Array.from({ length: MAX_STATIC_LINKS + 1 }, () => kick)],
  ];

  it.each(bad)('%s: отклоняется целиком, сохранённый список цел', (_name, value) => {
    store.setStaticLinks([kick]);

    expect(() => store.setStaticLinks(value)).toThrow(StaticLinksError);
    expect(store.staticLinks()).toEqual([kick]);
  });

  it('предельное число ссылок принимается', () => {
    const links = Array.from({ length: MAX_STATIC_LINKS }, (_, i) => ({ label: `L${i}`, url: `https://a.example/${i}`, always: false }));

    expect(store.setStaticLinks(links)).toHaveLength(MAX_STATIC_LINKS);
  });
});
