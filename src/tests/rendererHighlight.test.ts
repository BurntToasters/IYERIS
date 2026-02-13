import { describe, it, expect } from 'vitest';
import { getLanguageForExt } from '../rendererHighlight';

describe('getLanguageForExt', () => {
  it('maps JavaScript extensions', () => {
    expect(getLanguageForExt('js')).toBe('javascript');
    expect(getLanguageForExt('jsx')).toBe('javascript');
  });

  it('maps TypeScript extensions', () => {
    expect(getLanguageForExt('ts')).toBe('typescript');
    expect(getLanguageForExt('tsx')).toBe('typescript');
  });

  it('maps Python extensions', () => {
    expect(getLanguageForExt('py')).toBe('python');
    expect(getLanguageForExt('pyc')).toBe('python');
    expect(getLanguageForExt('pyw')).toBe('python');
  });

  it('maps Ruby', () => {
    expect(getLanguageForExt('rb')).toBe('ruby');
  });

  it('maps systems languages', () => {
    expect(getLanguageForExt('go')).toBe('go');
    expect(getLanguageForExt('rs')).toBe('rust');
    expect(getLanguageForExt('swift')).toBe('swift');
    expect(getLanguageForExt('java')).toBe('java');
  });

  it('maps C/C++ variants', () => {
    expect(getLanguageForExt('c')).toBe('c');
    expect(getLanguageForExt('h')).toBe('c');
    expect(getLanguageForExt('cpp')).toBe('cpp');
    expect(getLanguageForExt('cc')).toBe('cpp');
    expect(getLanguageForExt('cxx')).toBe('cpp');
    expect(getLanguageForExt('hpp')).toBe('cpp');
  });

  it('maps C# and PHP', () => {
    expect(getLanguageForExt('cs')).toBe('csharp');
    expect(getLanguageForExt('php')).toBe('php');
  });

  it('maps Kotlin and Scala', () => {
    expect(getLanguageForExt('kt')).toBe('kotlin');
    expect(getLanguageForExt('kts')).toBe('kotlin');
    expect(getLanguageForExt('scala')).toBe('scala');
  });

  it('maps shell scripting languages', () => {
    expect(getLanguageForExt('sh')).toBe('bash');
    expect(getLanguageForExt('bash')).toBe('bash');
    expect(getLanguageForExt('zsh')).toBe('bash');
    expect(getLanguageForExt('fish')).toBe('bash');
    expect(getLanguageForExt('ps1')).toBe('powershell');
  });

  it('maps markup languages', () => {
    expect(getLanguageForExt('html')).toBe('xml');
    expect(getLanguageForExt('htm')).toBe('xml');
    expect(getLanguageForExt('xml')).toBe('xml');
    expect(getLanguageForExt('svg')).toBe('xml');
    expect(getLanguageForExt('vue')).toBe('xml');
    expect(getLanguageForExt('svelte')).toBe('xml');
  });

  it('maps style languages', () => {
    expect(getLanguageForExt('css')).toBe('css');
    expect(getLanguageForExt('scss')).toBe('scss');
    expect(getLanguageForExt('sass')).toBe('scss');
    expect(getLanguageForExt('less')).toBe('less');
  });

  it('maps data formats', () => {
    expect(getLanguageForExt('json')).toBe('json');
    expect(getLanguageForExt('yml')).toBe('yaml');
    expect(getLanguageForExt('yaml')).toBe('yaml');
    expect(getLanguageForExt('toml')).toBe('ini');
    expect(getLanguageForExt('ini')).toBe('ini');
  });

  it('maps misc languages', () => {
    expect(getLanguageForExt('sql')).toBe('sql');
    expect(getLanguageForExt('md')).toBe('markdown');
    expect(getLanguageForExt('markdown')).toBe('markdown');
    expect(getLanguageForExt('r')).toBe('r');
    expect(getLanguageForExt('lua')).toBe('lua');
    expect(getLanguageForExt('perl')).toBe('perl');
    expect(getLanguageForExt('pl')).toBe('perl');
  });

  it('maps build tools', () => {
    expect(getLanguageForExt('dockerfile')).toBe('dockerfile');
    expect(getLanguageForExt('makefile')).toBe('makefile');
    expect(getLanguageForExt('cmake')).toBe('cmake');
  });

  it('returns null for unknown extensions', () => {
    expect(getLanguageForExt('xyz')).toBeNull();
    expect(getLanguageForExt('abc')).toBeNull();
    expect(getLanguageForExt('')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(getLanguageForExt('JS')).toBe('javascript');
    expect(getLanguageForExt('PY')).toBe('python');
    expect(getLanguageForExt('Html')).toBe('xml');
  });
});
