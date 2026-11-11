-- Provisional taxonomy, to be validated with marketing.
-- "other" is for mentions that fit no listed theme, not a marker for "no themes".
INSERT INTO themes (slug, label) VALUES
  ('housekeeping', 'Housekeeping'),
  ('rooms',        'Rooms'),
  ('front-desk',   'Front desk'),
  ('food',         'Food'),
  ('spa',          'Spa'),
  ('parking',      'Parking'),
  ('value',        'Value'),
  ('other',        'Other')
ON CONFLICT (slug) DO NOTHING;
