from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt, RGBColor, Cm
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

OUT=Path(__file__).parent
doc=Document()
sec=doc.sections[0]
sec.page_height=Cm(29.7); sec.page_width=Cm(21)
sec.top_margin=Cm(1.4); sec.bottom_margin=Cm(1.4)
sec.left_margin=Cm(1.7); sec.right_margin=Cm(1.7)
for name in ['Normal','Title','Heading 1','Heading 2']:
    st=doc.styles[name]; st.font.name='Malgun Gothic'; st._element.rPr.rFonts.set(qn('w:eastAsia'),'Malgun Gothic')
    st.font.color.rgb=RGBColor(0,0,0)
normal=doc.styles['Normal']; normal.font.size=Pt(10.2)
normal.paragraph_format.line_spacing=Pt(13)
normal.paragraph_format.space_after=Pt(4)
doc.styles['Title'].font.size=Pt(23)
doc.styles['Heading 1'].font.size=Pt(17)
doc.styles['Heading 2'].font.size=Pt(11)
for name in ['Heading 1','Heading 2']:
    doc.styles[name].paragraph_format.space_before=Pt(7)
    doc.styles[name].paragraph_format.space_after=Pt(3)
footer=sec.footer.paragraphs[0];footer.alignment=2
r=footer.add_run('NEURIA  |  ');r.font.size=Pt(8)
field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');footer._p.append(field)
doc.core_properties.title='NEURIA 프로젝트 발표 대본과 구현 현황'
doc.core_properties.subject='3분 발표 및 기술 구성과 검증 결과'
doc.core_properties.author='NEURIA 프로젝트'

def p(text,style=None): return doc.add_paragraph(text,style)
def h(text): return doc.add_heading(text,2)
def page(title): doc.add_page_break();doc.add_heading(title,1)
def table(headers,rows,widths):
    t=doc.add_table(rows=1,cols=len(headers));t.autofit=False
    for c,w in zip(t.columns,widths): c.width=Cm(w)
    for c,s in zip(t.rows[0].cells,headers):c.text=s
    header=OxmlElement('w:tblHeader');t.rows[0]._tr.get_or_add_trPr().append(header)
    for values in rows:
        for c,s in zip(t.add_row().cells,values):c.text=str(s)
    for i,row in enumerate(t.rows):
        pr=OxmlElement('w:cantSplit');row._tr.get_or_add_trPr().append(pr)
        for c,w in zip(row.cells,widths):
            c.width=Cm(w)
            c.vertical_alignment=1
            tcPr=c._tc.get_or_add_tcPr(); margins=OxmlElement('w:tcMar')
            for edge in ['top','left','bottom','right']:
                v=OxmlElement('w:'+edge);v.set(qn('w:w'),'85');v.set(qn('w:type'),'dxa');margins.append(v)
            tcPr.append(margins)
            for para in c.paragraphs:
                para.paragraph_format.space_after=Pt(3)
                para.paragraph_format.line_spacing=1.05
                for run in para.runs:run.font.size=Pt(9);run.bold=(i==0)
    p('')
    return t

doc.add_heading('NEURIA 프로젝트 발표 대본',0)
p('3분 발표와 구현 현황 정리  |  2026년 10월 30일 기준')
p('첫 페이지는 그대로 읽는 발표 대본입니다. 뒤의 기술·평가 자료는 질의응답용입니다. 현재 서비스는 MRI 이해를 돕는 시연 도구이며, 진단이나 임상 성능이 검증된 제품은 아닙니다.')
script=[
('0분 00초부터 0분 25초  소개',
'안녕하세요. 제가 만든 NEURIA는 어려운 MRI 분석 결과를 일반인이 이해하기 쉬운 말로 보여 주는 웹 서비스입니다. 영상을 올리면 네 가지 유형의 분류 결과와 모델이 참고한 영역, 그리고 의사에게 물어볼 질문을 함께 정리합니다. 병을 확진하는 서비스가 아니라, 결과를 이해하고 진료 질문을 준비하는 도구입니다.'),
('0분 25초부터 1분 05초  작동 과정',
'작동 과정은 MRI 업로드, 전처리, 분류, 주목 영역 표시, 쉬운 설명, 결과 화면 순서입니다. 먼저 사진을 RGB로 변환하고 크기와 수치를 정규화합니다. 현재는 이미지넷으로 사전학습된 EfficientNet B0가 영상 특징을 추출하고, 로지스틱 회귀가 신경교종, 수막종, 뇌하수체종양, 종양 없음의 네 유형으로 나눕니다. 부위 표시는 Grad CAM이 아니라 사진 일부를 가려 보며 분류 확률이 얼마나 달라지는지 확인하는 방식입니다. 따라서 표시된 곳은 병변의 정확한 경계가 아닙니다.'),
('1분 05초부터 1분 35초  사용 기술과 개발 방법',
'화면은 HTML, CSS, 자바스크립트로 만들고, Node.js로 웹 서버를, 파이썬으로 분석 서버를 구성했습니다. 딥러닝은 파이토치를 사용했습니다. 개발 과정에서 Claude로 웹 기능과 CNN 후보를 구현하고, Codex로 코드를 검토하며 데이터 중복 검사, 모델 비교, 보안 보완을 진행했습니다. 설명문은 별도의 대화형 AI가 작성하는 것이 아니라, 분석 결과를 정해진 문장 규칙에 넣어 만듭니다.'),
('1분 35초부터 2분 10초  정확도와 검증',
'현재 적용한 EfficientNet 기반 모델은 내부의 탐색용 테스트 천삼백칠십육 장에서 정확도 약 97.6퍼센트를 기록했습니다. 하지만 반복 확인한 공개 데이터의 결과이므로, 실제 환자에게도 같은 정확도가 나온다는 뜻은 아닙니다. 유사한 사진이 학습과 평가에 함께 들어가지 않도록 검사했고, 다섯 개 그룹 분할의 평균 매크로 F1은 약 0.931이었습니다. 다른 CNN 후보도 추가 학습했으며 최종 비교를 진행하고 있습니다.'),
('2분 10초부터 2분 40초  개인정보 보호',
'개인정보 보호를 위해 기본 모드는 이름이나 이메일 없이 사용할 수 있고, 분석 기록을 저장하지 않습니다. 영상은 같은 컴퓨터의 분석 서버에서 처리하며, 외부 사이트에서 영상이 전송되지 않도록 차단했습니다. 나가거나 일정 시간 사용하지 않으면 화면과 임시 정보를 정리합니다. 다만 영상에 이미 찍힌 이름이나 환자번호를 자동으로 가리는 기능은 없어, 사용 전에 해당 정보를 가려야 합니다.'),
('2분 40초부터 3분 00초  한계와 다음 단계',
'현재 업로드부터 결과 표시까지는 구현했습니다. 남은 과제는 새로운 병원 자료에서의 검증과 환자 단위 평가, 정확한 병변 분할입니다. 지금의 주목 영역만으로 종양 크기나 호전과 악화를 판단할 수는 없습니다. 앞으로는 정확도 수치뿐 아니라 데이터의 독립성과 개인정보 보호까지 함께 검증하겠습니다. 감사합니다.')]
for title,text in script:h(title);p(text)

page('실제 처리 흐름과 사용 기술')
p('현재 활성 모델의 흐름을 설명합니다. 사용자가 예시로 제시한 Grad CAM 단계는 현재 코드의 가림 실험 방식으로 바로잡았습니다.')
h('발표 슬라이드에 넣을 한 줄 흐름')
p('MRI 업로드 → ① 전처리 → ② EfficientNet B0 특징 추출과 로지스틱 회귀 분류 → ③ 가림 실험으로 주목 영역 표시 → ④ 규칙 기반 쉬운 설명과 질문 구성 → ⑤ 결과 화면')
table(['단계','실제 구현'],[
('업로드','브라우저에서 JPG·PNG 등 표시 가능한 이미지를 읽어 캔버스에 올립니다. 분석 요청은 JPEG로 다시 인코딩해 같은 컴퓨터의 서버로 보냅니다.'),
('전처리','RGB 변환, 비율을 유지하는 크기 조정, 중앙 224×224 자르기, ImageNet 기준 정규화를 적용합니다. 크기·형식·과도한 종횡비도 검사합니다.'),
('특징과 분류','EfficientNet B0의 고정된 사전학습 특징 1,280개를 추출합니다. 별도로 학습한 로지스틱 회귀 분류 헤드가 네 유형의 확률을 계산합니다.'),
('주목 영역','입력 일부를 48픽셀 블록으로 가린 뒤 선택 유형의 확률 감소를 누적합니다. 지도를 원본 좌표로 되돌려 주목 영역 A·B·C로 표시합니다. 병변 마스크가 아닙니다.'),
('설명과 화면','자바스크립트의 정해진 문장·용어·질문 규칙으로 설명합니다. 생성형 언어모델 API는 사용하지 않습니다. 분석 서버가 없으면 브라우저의 시연용 데모 분석으로 대체됩니다.')],[3.1,13.9])
h('언어와 라이브러리')
table(['구분','사용 기술','역할'],[
('화면','HTML · CSS · JavaScript','구조, 스타일, 영상 캔버스, 결과·설명·질문 표시'),
('웹 서버','Node.js · JavaScript','로컬 웹 제공, 분석 요청 중계, 접근 경로·외부 요청 통제'),
('분석과 학습','Python · PyTorch · torchvision','CNN 특징 추출, 미세조정, 자체 CNN 학습'),
('머신러닝','scikit-learn · NumPy · scikit-image','로지스틱 회귀, SVM, RandomForest, HOG 특징과 평가'),
('협업과 검증','Claude · Codex · GitHub Actions','AI 보조 개발, 코드 검토, 재현 실험, 자동 회귀 검사')],[2.8,5.8,8.4])
p('구별할 점: HTML과 CSS는 화면 구조·스타일 기술입니다. 딥러닝은 영상 특징을 학습하는 CNN 부분이고, 최종 로지스틱 회귀는 전통적인 머신러닝 분류기입니다.')

page('모델 성능과 현재 완료 수준')
p('현재 기본 모델은 EfficientNet B0의 고정 특징과 로지스틱 회귀를 결합한 방식입니다. 시험한 모델 모두가 현재 앱에서 동시에 실행되는 것은 아닙니다.')
table(['모델과 역할','같은 5개 그룹 분할의 평균 macro F1','상태'],[
('HOG와 SVM','0.9166','전통적 머신러닝 비교 기준'),
('MobileNet V3 Small 고정 특징','0.9210','전이학습 비교 후보'),
('MobileNet V3 Small 미세조정','0.9299','마지막 층까지 추가 학습한 후보'),
('EfficientNet B0 고정 특징','0.9307','현재 기본 모델로 선택'),
('SiriusNet 자체 CNN','최종 5개 분할 집계 미완료','별도 재학습·비교 중이며 미적용')],[7.0,5.7,4.3])
p('macro F1은 각 유형의 정밀도·재현율을 종합해 동일한 비중으로 평균한 지표입니다. 0.9307을 정확도 93.07%라고 바꾸어 말하면 안 됩니다. CNN 간 작은 차이만으로 통계적 우위를 확정하지 않았습니다.')
h('발표에서 사용할 정확도 표현')
p('“현재 모델은 중복을 점검한 내부 탐색용 테스트 1,376장에서 정확도 97.60%, macro F1 0.9732를 기록했습니다. 이 테스트는 이전 실험에서도 확인한 자료이므로 새로운 독립 평가나 임상 성능을 뜻하지 않습니다.”')
p('초기 HOG와 RandomForest의 72.7%는 다른 평가 조건의 과거 기록입니다. 72.7%에서 97.6%로 같은 시험의 성능이 개선됐다고 단순 비교하지 않습니다. Claude의 별도 CNN 후보가 기록한 99.2%도 다른 데이터의 결과이며, 그 후보는 다른 공개 자료에서 86.6%와 59.2%로 성능이 낮아졌습니다. 이 수치는 현재 EfficientNet 모델의 외부 정확도가 아닙니다.')
h('완료와 진행 상태')
table(['구분','현재 확인한 범위'],[
('구현 완료','업로드·분류·주목 영역·설명·질문·결과 화면. 기본 익명 모드, 저장·외부 요청 차단과 종료 시 정리.'),
('검증 완료','그룹 기반 모델 비교. JavaScript 48개·로컬 Python 26개 테스트 통과. 외부 보안 인증이나 실제 브라우저 전체 검증 완료는 아님.'),
('진행 중','자체 CNN을 22에폭씩 다섯 그룹에서 비교 중. 첫 분할 검증 정확도 94.12%, F1 0.9408. 작성 기준 네 분할 완료·최종 집계 전.'),
('확보한 자료','MRI 12K 중복 검사 후 1,418장 잔존. Figshare 원본 3,064장·233개 환자 그룹 확인. 정상 유형이 없어 네 유형 독립 평가용은 아님.')],[3.0,14.0])

page('한계와 발표 질의응답')
h('현재 부족한 점')
p('새 병원·새 촬영 조건에서의 성능을 확정하지 못했습니다. 기존 공개 영상은 원천이 겹치거나 환자 식별 정보가 없을 수 있어, 사진 중복 제거만으로 환자 단위 독립성을 증명할 수 없습니다. 확보한 Figshare 원본의 공식 분할에서는 환자 그룹이 여러 분할에 걸치는 경우가 0건이었지만, 기존 Kaggle 기반 모델의 분할까지 환자 독립이라고 확인한 것은 아닙니다.')
p('현재 주목 영역은 모델의 판단 근거를 가림 실험으로 추정한 결과입니다. Grad CAM의 기울기 기반 지도와 다르고, U Net 같은 병변 분할 모델의 픽셀 마스크도 아닙니다. 종양의 정확한 크기·경계·해부학적 위치·호전·악화를 판정하지 않습니다. 네 유형 밖의 질환을 분류하는 능력과 출력 확률의 임상적 신뢰성도 검증되지 않았습니다.')
p('기본 익명 모드는 새 계정·이메일·분석 기록을 저장하지 않습니다. 기존에 저장한 계정은 자동 삭제하지 않으며, 별도로 계정 기능을 켜면 수집 범위가 달라집니다. 영상 픽셀에 찍힌 개인정보 자동 익명화와 운영체제 메모리의 완전 삭제는 구현 범위에 포함되지 않습니다.')
h('예상 질문과 짧은 답변')
table(['질문','답변'],[
('Grad CAM을 썼나요','현재 활성 모델은 가림 실험인 occlusion sensitivity를 씁니다. CNN 후보의 CAM과도 구분합니다.'),
('설명은 ChatGPT가 쓰나요','실행 중에는 외부 LLM API를 호출하지 않습니다. 분석 결과와 정해진 문장 규칙으로 구성합니다. Claude와 Codex는 개발·검토 단계에 활용했습니다.'),
('97.6%면 진단할 수 있나요','아닙니다. 반복 확인한 내부 공개 데이터의 탐색 결과이며, 독립 환자·병원 검증이 필요합니다.'),
('왜 EfficientNet을 선택했나요','같은 다섯 그룹 분할에서 비교한 평균 macro F1이 가장 높았기 때문입니다. 차이가 작아 통계적 우월성은 단정하지 않았습니다.'),
('다음에 무엇을 하나요','자체 CNN 비교 완료, 환자 단위 재평가, 새로운 출처의 네 유형 검증, 별도 병변 마스크로 분할 학습을 진행합니다.')],[5.1,11.9])
h('근거 자료')
for s in [
'GitHub 저장소  https://github.com/knu3146/SIRIUS',
'현재 모델·비교 근거  ml/model_meta.json · reports/model-selection.json · reports/training-results.json',
'처리 흐름  ml/cnn_backend.py · ml/infer_server.py · js/engine.js · js/report.js',
'개인정보·회귀 검증  PRIVACY.md · reports/claude-privacy-review.md · test/ · ml/test_handler_privacy.py',
'자료 감사  reports/dataset-candidates.md · 로컬 Figshare 환자 그룹 감사 결과',
'원 자료  Jun Cheng의 Figshare brain tumor dataset v8  https://doi.org/10.6084/m9.figshare.1512427.v8',
'발표 길이는 말하기 속도에 따라 달라집니다. 첫 페이지의 시간 표시는 약 3분을 위한 연습 기준이며, 뒤의 자료는 발표 시간에 포함하지 않습니다.'
]:
    q=p(s)
    for r in q.runs:r.font.size=Pt(8.5)

path=OUT/'NEURIA_3minute_presentation_20261030.docx'
doc.save(path)
spoken=''.join(text for _,text in script)
print(str(path))
print('Script characters including spaces:',len(spoken))
