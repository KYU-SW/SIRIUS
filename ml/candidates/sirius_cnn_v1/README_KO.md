# sirius_cnn_v1 — 추가 학습 후보 모델 (데모 전용, 임상 검증 아님)

기존 모델/파일은 덮어쓰지 않은 **별도 후보**입니다.

## 데이터 출처
사용자 제공 archive.zip ("MRI Dataset": train 8000 / val 1000 / test 1000, 4클래스). 원출처 미확인(공개 Kaggle 계열로 보임). 환자 ID 없음 → 환자 단위 독립성은 보장 불가.

## 누수 점검 (ORB+RANSAC, inlier>=25 = 같은 원본의 증강본)
- SHA-256 정확 중복: 0건
- val 1000장 중 404장이 train 에, test 1000장 중 388장이 train 에 같은 원본 증강본 존재(test→val 154장). → 기존 72.7%·일부 지표는 누수 영향권.
- 학습: train 에서 val/test 와 같은 원본 1176장 제외(6824장 사용). 모델 선택: val_keep(850장)의 macro-F1. test 는 학습/튜닝에 미사용, 선택 후 1회 평가(reports/eval_log.jsonl).

## 결과 (test, 1000장 / 중복 제거 562장)
| 모델 | 전체 acc (95%CI) | 중복제거 acc | macro-F1(전체) |
|---|---|---|---|
| 기존 HOG+RF | 72.7% (69.9–75.4) | 72.6% | 0.719 |
| SiriusNet w1.5 (선택, 1.10M) | 99.2% (98.4–99.6) | 99.1% | 0.992 |
| SiriusNet w1.0 (비선택) | 99.0% | 98.6% | 0.990 |

클래스별(전체 test, 선택 모델) recall: glioma 0.976 / meningioma 0.992 / pituitary 1.000 / no_tumor 1.000. 상세·혼동행렬: reports/eval_cnn_w15_test.json

## 외부 일반화 (학습 미사용, archive 와 겹치는 영상 제외)
| 세트 | 남은 장수 | CNN acc | RF acc |
|---|---|---|---|
| kaggle 7200 Testing | 1177/1600 | 86.6% (84.5–88.4) | 63.6% |
| sartaj Testing | 157/394 | 59.2% (51.4–66.6), glioma recall 31% | 32.5% |
**결론: 같은 분포 안에서는 99%지만 다른 출처 영상에서는 87%·59%로 떨어집니다. 실제 사용 성능으로 해석하면 안 됩니다.** (sartaj 는 장수가 적고 클래스 불균형)

## 한계
- 환자 단위 분리 아님, 같은 연구에서 온 영상끼리의 평가, 외부 세트도 같은 공개 계열이라 완전 독립 아님
- 사전학습 가중치 다운로드 불가·GPU 없음 → CPU 에서 처음부터 학습(22에폭)
- 온도 보정 T=0.41(1 미만: label smoothing 보정) , 확률은 val 기준 보정
- 진단 도구 아님. CAM 은 모델 근거 지도이지 병변 마스크가 아님

## 재현과 파일 구분
현재 유지하는 재학습 절차는 [REPRODUCE.md](REPRODUCE.md)를 따르세요. 위 결과와 ONNX 파일은 Claude가 전달한 과거 실험 산출물이며 현재 활성 EfficientNet 모델의 결과가 아닙니다. 모델 바이너리는 공유하지만 원본 데이터, 이미지별 누수 목록과 예측 배열은 공개하지 않습니다.

`src/data_audit.py`, `external_overlap.py`, `leak_manifest.py`, `evaluate.py`, `export_onnx.py`는 과거 감사·평가 도구입니다. OpenCV, ONNX, ONNX Runtime이 별도로 필요합니다. 신뢰할 수 있는 로컬 데이터와 모델만 입력하세요. 이미지 경로가 포함된 출력은 로컬에 보관하세요.

`train_cnn.py`는 이후 안전한 캐시와 split별 로더로 변경됐으므로 과거 명령을 그대로 복사하지 마세요. 배포 ONNX 입력은 (B,1,128,128) float [0,1], 출력은 probs와 클래스별 CAM이며 임상 검증은 수행하지 않았습니다.
