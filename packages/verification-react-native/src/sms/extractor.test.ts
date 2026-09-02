import { describe, expect, it } from 'vitest';
import { extractCode } from './extractor.js';

const PLACEHOLDER = '{{CODE}}';
const APP_HASH = 'FA+9qCX9VSu';

const render = (template: string, code: string): string => template.replace(PLACEHOLDER, code);

describe('extractCode', () => {
  it('extracts from a plainly rendered template', () => {
    const template = 'Your DIDWW code is {{CODE}}. Do not share it.';
    expect(extractCode(template, 'Your DIDWW code is 123456. Do not share it.')).toBe('123456');
  });

  it('extracts from a Retriever-wrapped body with the app hash appended', () => {
    const template = 'Your DIDWW code is {{CODE}}. Do not share it.';
    const body = `<#> ${render(template, '123456')}\n${APP_HASH}`;
    expect(extractCode(template, body)).toBe('123456');
  });

  it('stops at the app hash when the placeholder ends the template', () => {
    const template = 'Your DIDWW code is {{CODE}}';
    expect(extractCode(template, `<#> Your DIDWW code is 123456 ${APP_HASH}`)).toBe('123456');
  });

  it('stops at an all-digit app hash when the placeholder ends the template', () => {
    const template = 'Your DIDWW code is {{CODE}}';
    expect(extractCode(template, '<#> Your DIDWW code is 123456 12345678901')).toBe('123456');
  });

  it('extracts when the placeholder opens the template', () => {
    const template = '{{CODE}} is your DIDWW code';
    expect(extractCode(template, `<#> 123456 is your DIDWW code ${APP_HASH}`)).toBe('123456');
  });

  it('extracts through carrier text prepended and appended', () => {
    expect(extractCode('Code: {{CODE}}', 'FREE MSG: Code: 987654 -- reply STOP to opt out')).toBe(
      '987654',
    );
  });

  it.each(['(', ')', '?', '+', '*', '[', ']', '^', '$', '.', '|', '\\', '{', '}'])(
    'matches the metacharacter %j literally',
    (character) => {
      const template = `Code${character} {{CODE}} ${character}end`;
      expect(extractCode(template, render(template, '123456'))).toBe('123456');
    },
  );

  it('matches a brace quantifier in the template literally', () => {
    const template = 'Retry in {2} min. Your DIDWW code is {{CODE}}';
    expect(extractCode(template, 'Retry in {2} min. Your DIDWW code is 123456')).toBe('123456');
  });

  it('matches a backslash escape sequence in the template literally', () => {
    const template = 'Ref C:\\d {{CODE}}';
    expect(extractCode(template, 'Ref C:\\d 123456')).toBe('123456');
    expect(extractCode(template, 'Ref C:5 123456')).toBeNull();
  });

  it.each(
    Array.from({ length: 0x7f - 0x20 }, (_unused, offset) => String.fromCharCode(0x20 + offset)),
  )('matches the character %j literally on both sides of the code', (character) => {
    const template = `A${character}B{{CODE}}C${character}D`;
    const other = character === '#' ? '~' : '#';
    expect(extractCode(template, render(template, '123456'))).toBe('123456');
    expect(extractCode(template, `A${other}B123456C${other}D`)).toBeNull();
  });

  it('does not truncate trailing template text', () => {
    const template = 'Code {{CODE}} for ACME';
    expect(extractCode(template, 'Code 123456 for OTHER')).toBeNull();
    expect(extractCode(template, 'Code 123456 for ACME')).toBe('123456');
  });

  it.each(['1234', '123456', '1234567890123'])('imposes no code length (%s)', (code) => {
    const template = 'Your DIDWW code is {{CODE}}.';
    expect(extractCode(template, render(template, code))).toBe(code);
  });

  it('returns null for a null template', () => {
    expect(extractCode(null, 'Your DIDWW code is 123456.')).toBeNull();
  });

  it('returns null for an undefined template', () => {
    expect(extractCode(undefined, 'Your DIDWW code is 123456.')).toBeNull();
  });

  it('returns null for an empty template', () => {
    expect(extractCode('', 'Your DIDWW code is 123456.')).toBeNull();
  });

  it('returns null for a template with no placeholder', () => {
    expect(extractCode('Your DIDWW code is on its way.', 'Your DIDWW code is 123456.')).toBeNull();
  });

  it('returns null for a body that does not match', () => {
    expect(extractCode('Your DIDWW code is {{CODE}}.', 'Delivery failed.')).toBeNull();
  });

  it('returns null for a body carrying no digits where the code belongs', () => {
    expect(extractCode('Your DIDWW code is {{CODE}}.', 'Your DIDWW code is later.')).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(extractCode('Your DIDWW code is {{CODE}}.', '')).toBeNull();
  });
});
