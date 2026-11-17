#!/usr/bin/env python3
"""src/의 조각(스타일, 화면, 분석 엔진, 앱)을 한 파일 index.html로 합침"""
from pathlib import Path

root = Path(__file__).parent
src = root / 'src'
css = (src / 'style.css').read_text(encoding='utf8')
markup = (src / 'markup.html').read_text(encoding='utf8')
core = (src / 'core.js').read_text(encoding='utf8')
app = (src / 'app.js').read_text(encoding='utf8')

html = f'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>복싱 코치</title>
<meta name="description" content="섀도복싱을 찍으면 펀치를 세고 가드·회수·턱·스탠스를 바로 코칭해 주는 웹앱">
<meta name="theme-color" content="#EE3F45">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&family=Poppins:wght@500;600;700&display=swap">
<style>
{css}</style>
</head>
<body>

{markup}
<script>
{core}</script>

<script type="module">
{app}</script>
</body>
</html>
'''
(root / 'index.html').write_text(html, encoding='utf8')
print(f'index.html {len(html.encode("utf8")) / 1024:.1f} KB')
