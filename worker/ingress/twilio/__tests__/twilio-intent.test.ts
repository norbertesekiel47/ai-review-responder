import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../twilio-intent';

describe('classifyIntent', () => {
  it('returns stop for Twilio OptOutType=STOP regardless of body', () => {
    expect(classifyIntent({ OptOutType: 'STOP', Body: 'whatever' }))
      .toEqual({ intent: 'stop', source: 'twilio_optouttype' });
  });

  it('returns start for Twilio OptOutType=START or UNSTOP', () => {
    expect(classifyIntent({ OptOutType: 'START' }).intent).toBe('start');
    expect(classifyIntent({ OptOutType: 'UNSTOP' }).intent).toBe('start');
  });

  it('classifies EN keyword "STOP" with punctuation', () => {
    expect(classifyIntent({ Body: 'STOP!' }).intent).toBe('stop');
    expect(classifyIntent({ Body: '  stop.  ' }).intent).toBe('stop');
  });

  it('classifies ES keyword "PARAR"', () => {
    expect(classifyIntent({ Body: 'PARAR' }).intent).toBe('stop');
  });

  it('classifies START keywords', () => {
    expect(classifyIntent({ Body: 'START' }).intent).toBe('start');
    expect(classifyIntent({ Body: 'YES' }).intent).toBe('start');
  });

  it('returns none for body without a keyword', () => {
    expect(classifyIntent({ Body: 'hello there' }).intent).toBe('none');
  });

  it('returns none for empty body and no OptOutType', () => {
    expect(classifyIntent({}).intent).toBe('none');
  });
});
