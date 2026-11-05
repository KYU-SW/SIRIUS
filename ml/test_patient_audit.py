import importlib.util
import io
import json
import unittest

import numpy as np

from audit_patient_groups import read_slice


@unittest.skipUnless(importlib.util.find_spec('h5py'), 'optional original-dataset dependency h5py is not installed')
class PatientGroupChecks(unittest.TestCase):
    def fixture(self, label=1, pid='SYNTHETIC-PRIVATE-PID'):
        import h5py
        stream = io.BytesIO()
        with h5py.File(stream, 'w') as file:
            data = file.create_group('cjdata')
            data['label'] = np.asarray([[label]], dtype=np.float64)
            data['PID'] = np.asarray([[ord(char)] for char in pid], dtype=np.uint16)
            data['image'] = np.arange(256, dtype=np.int16).reshape(16, 16)
        return stream.getvalue()

    def test_patient_identifier_is_opaque_and_stable_without_printing_original(self):
        first = read_slice(self.fixture())
        second = read_slice(self.fixture(label=2))
        self.assertEqual(first['patient_group'], second['patient_group'])
        self.assertEqual(len(first['patient_group']), 64)
        self.assertNotIn('SYNTHETIC-PRIVATE-PID', json.dumps(first))
        self.assertEqual(first['source_label'], 1)
        self.assertEqual(second['source_label'], 2)
        self.assertNotEqual(first['patient_group'], read_slice(self.fixture(pid='OTHER-PID'))['patient_group'])

    def test_unknown_labels_and_missing_patient_groups_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unknown original tumor label'):
            read_slice(self.fixture(label=4))
        with self.assertRaisesRegex(ValueError, 'Missing patient group'):
            read_slice(self.fixture(pid=''))


if __name__ == '__main__':
    unittest.main()
