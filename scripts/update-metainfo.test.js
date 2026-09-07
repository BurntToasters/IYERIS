import assert from 'node:assert/strict';
import test from 'node:test';
import { updateMetainfoXml } from './update-metainfo.js';

const BASE = `<component>
  <releases>
    <release version="3.0.4" date="2026-08-20"/>
    <release version="3.0.3" date="2026-07-17"/>
  </releases>
</component>
`;

test('existing release keeps date and update is idempotent', () => {
  const first = updateMetainfoXml(BASE, '3.0.4', { now: new Date('2026-09-01T00:00:00Z') });
  assert.equal(first.updated, false);
  assert.match(first.xml, /version="3\.0\.4" date="2026-08-20"/u);
  const second = updateMetainfoXml(first.xml, '3.0.4', {
    now: new Date('2026-09-02T00:00:00Z'),
  });
  assert.equal(second.updated, false);
});

test('explicit refresh changes existing release date', () => {
  const result = updateMetainfoXml(BASE, '3.0.4', {
    now: new Date('2026-09-01T00:00:00Z'),
    refreshDate: true,
  });
  assert.match(result.xml, /version="3\.0\.4" date="2026-09-01"/u);
});

test('explicit refresh adds a date to a detailed release entry', () => {
  const xml = `<component>
  <releases>
    <release version="3.0.5-beta.1"><description><p>Beta</p></description></release>
  </releases>
</component>`;
  const result = updateMetainfoXml(xml, '3.0.5-beta.1', {
    now: new Date('2026-09-02T12:00:00Z'),
    refreshDate: true,
  });

  assert.match(result.xml, /<release version="3\.0\.5-beta\.1" date="2026-09-02">/u);
  assert.match(result.xml, /<description><p>Beta<\/p><\/description>/u);
});

test('new release is inserted first and remains stable on rerun', () => {
  const first = updateMetainfoXml(BASE, '3.0.5-beta.1', {
    now: new Date('2026-09-01T00:00:00Z'),
  });
  assert.match(first.xml, /<releases>\s*<release version="3\.0\.5-beta\.1"/u);
  const second = updateMetainfoXml(first.xml, '3.0.5-beta.1', {
    now: new Date('2026-09-02T00:00:00Z'),
  });
  assert.equal(second.updated, false);
  assert.match(second.xml, /version="3\.0\.5-beta\.1" date="2026-09-01"/u);
});
