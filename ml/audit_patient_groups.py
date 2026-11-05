"""Audit original Figshare patient groups; never publish patient identifiers or image paths."""
import argparse
from collections import Counter, defaultdict
import hashlib
import io
import json
from pathlib import Path
import zipfile

import numpy as np
from sklearn.model_selection import StratifiedGroupKFold


def hash_file(path, algorithm):
    digest = hashlib.new(algorithm)
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def read_slice(content):
    import h5py
    with h5py.File(io.BytesIO(content), 'r') as file:
        data = file['cjdata']
        label = float(np.asarray(data['label']).item())
        if label not in (1, 2, 3):
            raise ValueError('Unknown original tumor label')
        pid = ''.join(chr(int(value)) for value in np.asarray(data['PID']).ravel()).strip('\x00 ')
        if not pid:
            raise ValueError('Missing patient group')
        image = np.asarray(data['image'])
        if image.ndim != 2 or not image.size or not np.isfinite(image).all():
            raise ValueError('Invalid image array')
        # Patient IDs stay opaque in private manifests and are never printed.
        patient = hashlib.sha256(('figshare-v8/' + pid).encode('utf-8')).hexdigest()
        pixels = hashlib.sha256(str((image.shape, image.dtype.str)).encode() + image.tobytes()).hexdigest()
        return {'source_label': int(label), 'patient_group': patient, 'pixel_sha256': pixels}


def audit(root):
    root = root.resolve()
    source = json.loads((root / 'source.json').read_text(encoding='utf-8-sig'))
    if source['version'] != 8:
        raise ValueError('This audit expects the documented Figshare v8 source')
    digests, rows = {}, []
    for info in source['files']:
        file = (root / info['name']).resolve()
        if not file.is_relative_to(root):
            raise ValueError('Source file escapes dataset directory')
        if hash_file(file, 'md5') != info['supplied_md5']:
            raise ValueError('Source checksum mismatch; wait for a verified completed download')
        digests[file.name] = hash_file(file, 'sha256')
        if file.suffix != '.zip':
            continue
        with zipfile.ZipFile(file) as archive:
            entries = [item for item in archive.infolist() if item.filename.endswith('.mat')]
            if sum(item.file_size for item in entries) > 1024**3:
                raise ValueError('Unexpected archive expansion size')
            for item in entries:
                identifier = int(Path(item.filename).stem)
                rows.append({'slice_id': identifier, **read_slice(archive.read(item))})
        print(f'Inspected original archive {file.name}', flush=True)
    rows.sort(key=lambda row: row['slice_id'])
    if [row['slice_id'] for row in rows] != list(range(1, 3065)):
        raise ValueError('Expected all 3064 original slice IDs exactly once')
    import h5py
    with h5py.File(root / 'cvind.mat', 'r') as file:
        values = np.asarray(file['cvind']).ravel()
    if len(values) != len(rows) or not np.isin(values, [1, 2, 3, 4, 5]).all():
        raise ValueError('Invalid official cross-validation indices')
    patient_folds, patient_labels, pixel_patients = defaultdict(set), defaultdict(set), defaultdict(set)
    for row, fold in zip(rows, values):
        row['official_fold'] = int(fold)
        patient_folds[row['patient_group']].add(int(fold))
        patient_labels[row['patient_group']].add(row['source_label'])
        pixel_patients[row['pixel_sha256']].add(row['patient_group'])
    # Duplicate pixels also bind their whole patient groups to one fold.
    parent = {patient: patient for patient in patient_folds}
    def find(patient):
        while parent[patient] != patient:
            parent[patient] = parent[parent[patient]]
            patient = parent[patient]
        return patient
    for patients in pixel_patients.values():
        patients = sorted(patients)
        for patient in patients[1:]:
            parent[find(patient)] = find(patients[0])
    groups = np.asarray([find(row['patient_group']) for row in rows])
    labels = np.asarray([row['source_label'] for row in rows])
    folds = []
    for number, (fit, validation) in enumerate(StratifiedGroupKFold(5, shuffle=True, random_state=42)
            .split(np.zeros((len(rows), 1)), labels, groups), start=1):
        if set(groups[fit]) & set(groups[validation]):
            raise ValueError('Generated patient groups overlap')
        for index in validation:
            rows[index]['patient_grouped_fold'] = number
        folds.append({'fold': number, 'fit_images': len(fit), 'validation_images': len(validation),
                      'fit_groups': len(set(groups[fit])), 'validation_groups': len(set(groups[validation]))})
    summary = {'source': source['url_public_html'], 'source_version': source['version'],
               'archive_files_sha256': digests, 'images': len(rows), 'patient_groups': len(patient_folds),
               'source_label_counts': dict(sorted(Counter(labels.tolist()).items())),
               'source_label_mapping': {'1': 'meningioma', '2': 'glioma', '3': 'pituitary'},
               'official_folds_patients_in_multiple_folds': sum(len(v) > 1 for v in patient_folds.values()),
               'patients_with_multiple_labels': sum(len(v) > 1 for v in patient_labels.values()),
               'pixel_duplicates_crossing_patient_ids': sum(len(v) > 1 for v in pixel_patients.values()),
               'generated_patient_grouped_folds': folds, 'predictions_or_training_performed': False,
               'limitations': ['No normal class: this is not a four-class evaluation cohort.',
                              'The Figshare source overlaps earlier Kaggle development sources; not a new external cohort.',
                              'Opaque patient group IDs and slice-level records stay local.']}
    return summary, rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--summary', type=Path, required=True)
    args = parser.parse_args()
    summary, rows = audit(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({**summary, 'records': rows}, indent=2), encoding='utf-8')
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
