#!/usr/bin/env python3
"""
Convert TOWER3_HTTPS_SETUP.md to PDF using reportlab
"""

from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, Preformatted
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
import re

def read_markdown(filepath):
    """Read markdown file and return content"""
    with open(filepath, 'r') as f:
        return f.read()

def parse_markdown_to_elements(markdown_text):
    """Parse markdown text and return a list of reportlab elements"""
    elements = []
    styles = getSampleStyleSheet()
    
    # Define custom styles
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=colors.HexColor('#1f4788'),
        spaceAfter=30,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold'
    )
    
    heading_style = ParagraphStyle(
        'CustomHeading',
        parent=styles['Heading2'],
        fontSize=14,
        textColor=colors.HexColor('#2c5aa0'),
        spaceAfter=12,
        spaceBefore=12,
        fontName='Helvetica-Bold'
    )
    
    body_style = ParagraphStyle(
        'CustomBody',
        parent=styles['BodyText'],
        fontSize=10,
        alignment=TA_JUSTIFY,
        spaceAfter=10,
        leading=14
    )
    
    code_style = ParagraphStyle(
        'Code',
        parent=styles['BodyText'],
        fontSize=8,
        fontName='Courier',
        textColor=colors.HexColor('#333333'),
        backColor=colors.HexColor('#f5f5f5'),
        leftIndent=20,
        spaceAfter=8,
        leading=10
    )
    
    lines = markdown_text.split('\n')
    i = 0
    
    while i < len(lines):
        line = lines[i]
        
        # Title (# text)
        if line.startswith('# '):
            text = line[2:].strip()
            elements.append(Paragraph(text, title_style))
            elements.append(Spacer(1, 0.2*inch))
            i += 1
            
        # Heading (## text)
        elif line.startswith('## '):
            text = line[3:].strip()
            elements.append(Paragraph(text, heading_style))
            i += 1
            
        # Code block (``` ... ```)
        elif line.startswith('```'):
            code_lines = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code_lines.append(lines[i])
                i += 1
            i += 1  # Skip closing ```
            code_text = '\n'.join(code_lines).strip()
            elements.append(Preformatted(code_text, code_style))
            elements.append(Spacer(1, 0.1*inch))
            
        # Horizontal rule (---)
        elif line.strip() == '---':
            elements.append(Spacer(1, 0.15*inch))
            i += 1
            
        # Bold text emphasis
        elif '**' in line or line.strip().startswith('- '):
            # Handle list items
            if line.strip().startswith('- '):
                bullet_text = '• ' + line.strip()[2:]
                # Apply markdown formatting
                bullet_text = re.sub(r'\*\*([^\*]+)\*\*', r'<b>\1</b>', bullet_text)
                bullet_text = re.sub(r'`([^`]+)`', r'<font name="Courier" size="8">\1</font>', bullet_text)
                list_style = ParagraphStyle(
                    'BulletStyle',
                    parent=body_style,
                    leftIndent=30,
                    bulletIndent=10
                )
                elements.append(Paragraph(bullet_text, list_style))
            else:
                # Replace markdown formatting
                text = line.strip()
                text = re.sub(r'\*\*([^\*]+)\*\*', r'<b>\1</b>', text)
                text = re.sub(r'`([^`]+)`', r'<font name="Courier" size="8">\1</font>', text)
                if text.strip():
                    elements.append(Paragraph(text, body_style))
            i += 1
            
        # Regular paragraph
        elif line.strip():
            # Replace markdown formatting (bold first to avoid conflicts)
            text = line.strip()
            # Bold: **text** -> <b>text</b>
            text = re.sub(r'\*\*([^\*]+)\*\*', r'<b>\1</b>', text)
            # Italic: *text* -> <i>text</i> (but not **text**)
            text = re.sub(r'(?<!\*)\*([^\*]+)\*(?!\*)', r'<i>\1</i>', text)
            # Code: `text` -> <font>text</font>
            text = re.sub(r'`([^`]+)`', r'<font name="Courier" size="8">\1</font>', text)
            if text.strip():
                elements.append(Paragraph(text, body_style))
            i += 1
            
        # Empty line
        else:
            elements.append(Spacer(1, 0.05*inch))
            i += 1
    
    return elements

def create_pdf(markdown_filepath, output_pdf):
    """Create PDF from markdown file"""
    # Read markdown
    markdown_content = read_markdown(markdown_filepath)
    
    # Parse to elements
    elements = parse_markdown_to_elements(markdown_content)
    
    # Create PDF
    doc = SimpleDocTemplate(
        output_pdf,
        pagesize=letter,
        rightMargin=0.75*inch,
        leftMargin=0.75*inch,
        topMargin=0.75*inch,
        bottomMargin=0.75*inch
    )
    
    # Build PDF
    doc.build(elements)
    print(f"✓ PDF created: {output_pdf}")

if __name__ == '__main__':
    import sys
    
    input_file = 'TOWER3_HTTPS_SETUP.md'
    output_file = 'TOWER3_HTTPS_SETUP.pdf'
    
    try:
        create_pdf(input_file, output_file)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
