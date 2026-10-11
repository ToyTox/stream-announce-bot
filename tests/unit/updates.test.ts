import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../../desktop/updates.js';

describe('isNewerVersion', () => {
  it('сравнивает по числам, а не по строкам', () => {
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
  });

  it('равная или старая версия — не обновление', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
  });

  it('понимает префикс v и суффикс пререлиза', () => {
    expect(isNewerVersion('v1.2.0', '1.1.0')).toBe(true);
    expect(isNewerVersion('1.2.0-beta.1', '1.1.0')).toBe(true);
  });

  it('мусор вместо версии — не обновление', () => {
    expect(isNewerVersion('latest', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.1.0', '')).toBe(false);
  });
});
