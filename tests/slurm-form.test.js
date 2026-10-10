import { describe, test, expect } from '@jest/globals';
import { buildHeaderFromDOM } from '../js/script-generator-slurm.js';

// The page's DOM helpers, over a plain object standing in for the job form.
function form(values) {
  const v = { jobScheduler: 'slurm', jobName: 'md_job', jobNodes: '1', jobCpus: '8', jobTasks: '1', jobGpus: '0',
              jobTime: '24:00:00', jobMem: '32G', ...values };
  return {
    getStr: (id, dflt) => (String(v[id] ?? '').trim() || dflt),
    getInt: (id, dflt) => { const n = parseInt(v[id] ?? '', 10); return Number.isFinite(n) ? n : dflt; },
    isChecked: id => v[id] === true
  };
}

function build(values, engine = 'gromacs') {
  const warnings = [];
  const result = buildHeaderFromDOM(engine, warnings, form(values));
  return { ...result, warnings };
}

describe('buildHeaderFromDOM', () => {
  test('a clean form gives a header and no warnings', () => {
    const { header, warnings, isArray, scheduler } = build({});
    expect(header).toContain('#SBATCH --time=24:00:00\n');
    expect(header).toContain('#SBATCH --mem=32G\n');
    expect(warnings).toEqual([]);
    expect(isArray).toBe(false);
    expect(scheduler).toBe('slurm');
  });

  test('the array range is only read when the switch is on', () => {
    expect(build({ jobArrayRange: '10-1' }).header).not.toContain('--array');
    const on = build({ jobArrayToggle: true, jobArrayRange: '1-5,10-15%2' });
    expect(on.header).toContain('#SBATCH --array=1-5,10-15%2\n');
    expect(on.isArray).toBe(true);
  });

  test('a value quoted from the form is set in monospace whole', () => {
    const { warnings } = build({ jobArrayToggle: true, jobArrayRange: '1-5%2,10-15' });
    expect(warnings[0]).toContain('Array range &quot;<code>1-5%2,10-15</code>&quot; is not valid');
  });

  test('a time is wrapped once, not once more for the range inside it', () => {
    const { warnings } = build({ jobTime: '1-99:00:00' });
    expect(warnings[0]).toContain('Wall time <code>1-99:00:00</code> has 99 hours');
    expect(warnings[0]).toContain('<code>123:00:00</code>');
    expect(warnings[0]).not.toContain('<code><code>');
  });

  test('directives and example ranges are set in monospace', () => {
    const { warnings } = build({ jobArrayToggle: true, jobArrayRange: '1-10' });
    expect(warnings[0]).toContain('<code>--mem=32G</code> is per task');
    expect(warnings[0]).toContain('(e.g. <code>1-10%4</code>)');
  });

  test('markup typed into a field is escaped', () => {
    const { header, warnings } = build({ jobMem: '<b>32</b>' });
    expect(header).not.toContain('--mem');
    expect(warnings[0]).toContain('Memory &quot;<code>&lt;b&gt;32&lt;/b&gt;</code>&quot; was not understood');
    expect(warnings[0]).not.toContain('<b>');
  });

  test('the same memory text is the same amount under each scheduler', () => {
    expect(build({ jobMem: '4000' }).header).toContain('#SBATCH --mem=4000M\n');
    expect(build({ jobMem: '4000', jobScheduler: 'pbs' }).header).toContain(':mem=4000mb\n');
    expect(build({ jobMem: '4000', jobScheduler: 'lsf' }).header).toContain('rusage[mem=4000]');
    expect(build({ jobMem: '4000', jobScheduler: 'sge' }).header).toContain('#$ -l h_vmem=4000M\n');
  });
});
