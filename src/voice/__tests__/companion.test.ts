import { describe, expect, it } from 'vitest';
import { companionLine, matchFeelingPhrase, type CompanionContext } from '../companion';

const base: CompanionContext = { state: 'steady', enabled: true };

describe('companionLine', () => {
  it('stays silent when disabled', () => {
    expect(companionLine({ ...base, enabled: false }).text).toBe('');
  });

  it('respects quiet hours (22:00–06:59)', () => {
    for (const hour of [22, 23, 3, 6]) {
      expect(companionLine({ ...base, state: 'post-alert-wait', minutesSinceLastSuccess: 0, hour }).text).toBe('');
    }
    expect(companionLine({ ...base, state: 'post-alert-wait', minutesSinceLastSuccess: 0, hour: 12 }).text).not.toBe('');
  });

  it('speaks immediately after an SOS is acknowledged, then at 5 min, then every 10', () => {
    expect(companionLine({ ...base, state: 'post-alert-wait', minutesSinceLastSuccess: 0 }).text).toContain('alert is out');
    expect(companionLine({ ...base, state: 'post-alert-wait', minutesSinceLastSuccess: 2 }).text).toBe('');
    expect(companionLine({ ...base, state: 'post-alert-wait', minutesSinceLastSuccess: 5 }).text).not.toBe('');
    expect(companionLine({ ...base, state: 'post-alert-wait', minutesSinceLastSuccess: 15 }).text).not.toBe('');
    expect(companionLine({ ...base, state: 'post-alert-wait', minutesSinceLastSuccess: 6 }).text).toBe('');
  });

  it('waits for a real frustration streak (2+ unknowns) before speaking', () => {
    expect(companionLine({ ...base, state: 'frustrated', consecutiveUnknowns: 1 }).text).toBe('');
    expect(companionLine({ ...base, state: 'frustrated', consecutiveUnknowns: 2 }).text).toContain('No rush');
  });

  it('never gives the companion a speech priority above background/description', () => {
    for (const state of ['frustrated', 'post-alert-wait', 'navigating-unfamiliar'] as const) {
      expect(companionLine({ ...base, state, minutesSinceLastSuccess: 0, consecutiveUnknowns: 3 }).priority).toBeGreaterThanOrEqual(6);
    }
  });

  it('stays silent in steady state', () => {
    expect(companionLine(base).text).toBe('');
  });
});

describe('matchFeelingPhrase', () => {
  it('answers fear with an honest, actionable line and an emergency offer', () => {
    const line = matchFeelingPhrase("hey watchora I'm scared right now");
    expect(line).not.toBeNull();
    expect(line!.text).toContain('emergency');
    // Never claims to know the feeling.
    expect(line!.text.toLowerCase()).not.toContain('i know how you feel');
  });

  it('routes feeling words away from the unknown-command path with priority 4', () => {
    const line = matchFeelingPhrase('I feel alone in this city');
    expect(line).not.toBeNull();
    expect(line!.priority).toBe(4);
  });

  it('does not fire on ordinary commands', () => {
    expect(matchFeelingPhrase('what is ahead of me')).toBeNull();
    expect(matchFeelingPhrase('read this label')).toBeNull();
  });

  it('never produces therapy-speak patterns', () => {
    for (const transcript of ["I'm scared", 'I feel alone', "I'm lost", "I can't do this", "I'm tired"]) {
      const line = matchFeelingPhrase(transcript);
      expect(line).not.toBeNull();
      const low = line!.text.toLowerCase();
      expect(low).not.toContain('i understand exactly');
      expect(low).not.toContain('everything happens for a reason');
      expect(low).not.toContain('calm down');
    }
  });
});
