-- DUMMY DATA for proof of concept only. Voter names, polling districts and localities are fictional.
-- Parliament/DUN numbers match real seats so live candidate data from ElectionData.MY lines up.

INSERT INTO localities (code, state, par_code, par_name, dun_code, dun_name, dm_code, dm_name, name) VALUES
  ('172/19/01/001', 'SABAH', '172', 'KOTA KINABALU', '172/19', 'LIKAS',            '172/19/01', 'LIKAS',            'KG LIKAS'),
  ('172/20/01/001', 'SABAH', '172', 'KOTA KINABALU', '172/20', 'API-API',          '172/20/01', 'API-API',          'TAMAN API-API'),
  ('172/21/01/001', 'SABAH', '172', 'KOTA KINABALU', '172/21', 'LUYANG',           '172/21/01', 'LUYANG',           'TAMAN LUYANG'),
  ('173/23/01/001', 'SABAH', '173', 'PUTATAN',       '173/23', 'PETAGAS',          '173/23/01', 'PETAGAS',          'KG PETAGAS'),
  ('173/23/01/002', 'SABAH', '173', 'PUTATAN',       '173/23', 'PETAGAS',          '173/23/01', 'PETAGAS',          'TAMAN PETAGAS INDAH'),
  ('173/23/02/001', 'SABAH', '173', 'PUTATAN',       '173/23', 'PETAGAS',          '173/23/02', 'PUTATAN BARU',     'KG PUTATAN BARU'),
  ('173/24/01/001', 'SABAH', '173', 'PUTATAN',       '173/24', 'TANJUNG KERAMAT',  '173/24/01', 'TANJUNG KERAMAT',  'KG TANJUNG KERAMAT'),
  ('173/24/02/001', 'SABAH', '173', 'PUTATAN',       '173/24', 'TANJUNG KERAMAT',  '173/24/02', 'UMBUL',            'KG UMBUL'),
  ('174/25/01/001', 'SABAH', '174', 'PENAMPANG',     '174/25', 'KAPAYAN',          '174/25/01', 'KAPAYAN',          'KG KAPAYAN BARU'),
  ('174/26/01/001', 'SABAH', '174', 'PENAMPANG',     '174/26', 'MOYOG',            '174/26/01', 'MOYOG',            'KG MOYOG'),
  ('174/26/02/001', 'SABAH', '174', 'PENAMPANG',     '174/26', 'MOYOG',            '174/26/02', 'DONGGONGON',       'PEKAN DONGGONGON')
ON CONFLICT (code) DO UPDATE SET
  state = EXCLUDED.state, par_code = EXCLUDED.par_code, par_name = EXCLUDED.par_name,
  dun_code = EXCLUDED.dun_code, dun_name = EXCLUDED.dun_name,
  dm_code = EXCLUDED.dm_code, dm_name = EXCLUDED.dm_name, name = EXCLUDED.name;

INSERT INTO voters (ic, full_name, dob, gender, locality_code) VALUES
  ('990123125571', 'MOHD FITRI BIN MANSOR',        '1999-01-23', 'LELAKI',    '173/23/01/001'),
  ('470621125137', 'ABDUL RAHMAN BIN SALLEH',      '1947-06-21', 'LELAKI',    '173/23/02/001'),
  ('650812125246', 'SITI AMINAH BINTI MATSAH',     '1965-08-12', 'PEREMPUAN', '173/24/01/001'),
  ('580304125013', 'LIM CHEE KONG',                '1958-03-04', 'LELAKI',    '172/19/01/001'),
  ('720915126288', 'ROSALINE MOJUNTIN',            '1972-09-15', 'PEREMPUAN', '174/26/01/001')
ON CONFLICT (ic) DO NOTHING;

INSERT INTO survey_questions (id, position, prompt, options) VALUES
  ('q1', 1, 'Apakah isu paling penting bagi anda dalam pilihan raya akan datang?',
   '[{"key":"A","label":"Kos sara hidup dan harga barang"},
     {"key":"B","label":"Peluang pekerjaan dan ekonomi"},
     {"key":"C","label":"Kemudahan asas (jalan, air, elektrik)"},
     {"key":"D","label":"Integriti dan tadbir urus kerajaan"}]'),
  ('q2', 2, 'Sejauh manakah anda pasti akan keluar mengundi?',
   '[{"key":"A","label":"Pasti akan mengundi"},
     {"key":"B","label":"Mungkin akan mengundi"},
     {"key":"C","label":"Belum pasti lagi"},
     {"key":"D","label":"Tidak akan mengundi"}]')
ON CONFLICT (id) DO UPDATE SET
  position = EXCLUDED.position, prompt = EXCLUDED.prompt, options = EXCLUDED.options;
