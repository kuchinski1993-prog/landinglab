// cents.ts tests — Fase 8A do Landing Lab Stabilization.

import { describe, expect, it } from 'vitest';

import { centsToDecimal, currencyMinorUnitDigits, decimalToCents, minorUnitsToMajor } from '../cents.js';

describe('centsToDecimal', () => {
  it('converte cents padrão em decimal string com 2 casas', () => {
    expect(centsToDecimal(2500)).toBe('25.00');
    expect(centsToDecimal(3999)).toBe('39.99');
    expect(centsToDecimal(5999)).toBe('59.99');
    expect(centsToDecimal(100)).toBe('1.00');
    expect(centsToDecimal(0)).toBe('0.00');
  });

  it('aceita string numérica (drizzle-pg às vezes serializa integer como string)', () => {
    expect(centsToDecimal('2500')).toBe('25.00');
    expect(centsToDecimal('3999')).toBe('39.99');
  });

  it('retorna "0.00" pra input inválido (não lança)', () => {
    expect(centsToDecimal(null)).toBe('0.00');
    expect(centsToDecimal(undefined)).toBe('0.00');
    expect(centsToDecimal('abc')).toBe('0.00');
    expect(centsToDecimal(NaN)).toBe('0.00');
    expect(centsToDecimal(Infinity)).toBe('0.00');
  });

  it('trata cents negativos corretamente (edge case desconto)', () => {
    expect(centsToDecimal(-500)).toBe('-5.00');
  });

  it('trata cents grandes (edge case JPY sem decimais persistido em cents)', () => {
    expect(centsToDecimal(1234567)).toBe('12345.67');
  });
});

describe('decimalToCents', () => {
  it('converte decimal number em cents integer', () => {
    expect(decimalToCents(25.0)).toBe(2500);
    expect(decimalToCents(39.99)).toBe(3999);
    expect(decimalToCents(1.0)).toBe(100);
    expect(decimalToCents(0)).toBe(0);
  });

  it('converte decimal string com ponto', () => {
    expect(decimalToCents('25.00')).toBe(2500);
    expect(decimalToCents('39.99')).toBe(3999);
  });

  it('converte decimal string com vírgula (locales BR/EU)', () => {
    expect(decimalToCents('25,00')).toBe(2500);
    expect(decimalToCents('39,99')).toBe(3999);
  });

  it('separador de milhar NÃO é suportado (fora do escopo — caller deve normalizar)', () => {
    // '1.299,90' fica ambíguo (ponto = milhar em BR, decimal em US).
    // Util aceita SÓ vírgula-ou-ponto como decimal singular; separador de milhar
    // deve ser removido pelo caller antes de chamar decimalToCents.
    // Comportamento atual: parseFloat lê '1.299.90' como 1.299 → 130 cents.
    expect(decimalToCents('1.299,90')).toBe(130); // documenta comportamento — NÃO use com milhar
  });

  it('retorna 0 pra input inválido (não lança)', () => {
    expect(decimalToCents(null)).toBe(0);
    expect(decimalToCents(undefined)).toBe(0);
    expect(decimalToCents('')).toBe(0);
    expect(decimalToCents('abc')).toBe(0);
    expect(decimalToCents(NaN)).toBe(0);
    expect(decimalToCents(Infinity)).toBe(0);
  });

  it('arredonda pra inteiro mais próximo (evita float impreciso)', () => {
    // 19.99 * 100 pode virar 1998.9999999 em float → deve virar 1999
    expect(decimalToCents(19.99)).toBe(1999);
    expect(decimalToCents(0.1 + 0.2)).toBe(30); // 0.30000004 → 30
  });

  it('roundtrip: decimalToCents(centsToDecimal(x)) === x', () => {
    for (const cents of [0, 100, 1999, 2500, 3999, 5999, 12345]) {
      expect(decimalToCents(centsToDecimal(cents))).toBe(cents);
    }
  });
});

describe('currencyMinorUnitDigits', () => {
  it('JPY → 0 (zero-decimal)', () => {
    expect(currencyMinorUnitDigits('JPY')).toBe(0);
    expect(currencyMinorUnitDigits('jpy')).toBe(0); // case-insensitive
  });
  it('USD/EUR/BRL → 2', () => {
    expect(currencyMinorUnitDigits('USD')).toBe(2);
    expect(currencyMinorUnitDigits('EUR')).toBe(2);
    expect(currencyMinorUnitDigits('BRL')).toBe(2);
  });
  it('fallback pra moeda inválida → 2', () => {
    expect(currencyMinorUnitDigits('XYZ')).toBe(2);
    expect(currencyMinorUnitDigits('')).toBe(2);
  });
});

describe('minorUnitsToMajor', () => {
  it('JPY: 7980 → 7980 (divisor=1)', () => {
    expect(minorUnitsToMajor(7980, 'JPY')).toBe(7980);
    expect(minorUnitsToMajor(15690, 'JPY')).toBe(15690);
    expect(minorUnitsToMajor(23940, 'JPY')).toBe(23940);
  });
  it('USD: 7980 → 79.80 (divisor=100)', () => {
    expect(minorUnitsToMajor(7980, 'USD')).toBe(79.80);
    expect(minorUnitsToMajor(100, 'USD')).toBe(1.00);
  });
  it('EUR: 7980 → 79.80', () => {
    expect(minorUnitsToMajor(7980, 'EUR')).toBe(79.80);
  });
  it('0 → 0 para qualquer moeda', () => {
    expect(minorUnitsToMajor(0, 'JPY')).toBe(0);
    expect(minorUnitsToMajor(0, 'USD')).toBe(0);
  });
});
