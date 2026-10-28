"""Synthetic, independently keyed two-page worksheet for opt-in R5 extraction."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

out = Path('.local/r5')
out.mkdir(parents=True, exist_ok=True)
c = canvas.Canvas(str(out / 'mathematics.pdf'), pagesize=A4)

def text(y, value, size=14):
    c.setFont('Helvetica', size)
    c.drawString(48, y, value)

text(790, 'R5 Synthetic Mathematics - Page 1', 18)
text(750, 'Choose one answer for each question. Show your working.')
text(680, '7a. Solve 3x + 5 = 20.')
text(645, 'A. 3          B. 5          C. 8          D. 15')
text(540, '7b. Calculate 3/4 + 2/3. Give the result as a fraction.')
text(505, 'A. 5/7       B. 13/12      C. 17/12      D. 7/12')
text(400, '8. A notebook costs 18 pesos. Find the cost of 4 notebooks.')
text(365, 'A. 22 pesos   B. 54 pesos   C. 72 pesos   D. 80 pesos')
c.showPage()
text(790, 'R5 Synthetic Mathematics - Page 2', 18)
text(710, '21. Find the area of the right triangle shown below.')
c.setLineWidth(2)
p = c.beginPath(); p.moveTo(130, 520); p.lineTo(310, 520); p.lineTo(130, 640); p.close()
c.drawPath(p)
c.rect(130, 520, 12, 12)
text(570, '6 cm')
c.drawString(200, 495, '8 cm')
text(455, 'A. 14 cm^2    B. 24 cm^2    C. 48 cm^2    D. 28 cm^2')
text(350, '22. Solve x/4 - 2 = 3.')
text(315, 'A. 4          B. 12         C. 20         D. 24')
text(210, '23. Simplify 2(3y - 4) + y.')
text(175, 'A. 7y - 8     B. 6y - 8     C. 7y - 4     D. 5y - 8')
c.save()
