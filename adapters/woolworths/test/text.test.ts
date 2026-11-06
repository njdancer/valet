import { describe, expect, it } from 'vitest'
import { cents, htmlToText, httpsUrl, list, text } from '../src/text'

describe('text', () => {
  it('trims strings and maps blanks and non-strings to null', () => {
    expect(text('  milk ')).toBe('milk')
    expect(text('   ')).toBeNull()
    expect(text(null)).toBeNull()
    expect(text(undefined)).toBeNull()
    expect(text(4)).toBeNull()
  })
})

describe('list', () => {
  it('splits on commas, trimming and dropping empties', () => {
    expect(list('Gluten Free, Low Salt,,Vegetarian ')).toEqual(['Gluten Free', 'Low Salt', 'Vegetarian'])
    expect(list(null)).toEqual([])
    expect(list('')).toEqual([])
  })
})

describe('htmlToText', () => {
  it('keeps line breaks and drops tags', () => {
    expect(htmlToText('Rich <b>and</b> creamy<br>Milk<br/><br />Done')).toBe('Rich and creamy\nMilk\n\nDone')
  })

  it('decodes the common entities and leaves others alone', () => {
    expect(htmlToText('Salt &amp; pepper &lt;3 &quot;hot&quot; &#39;n&#39; &nbsp;spicy &copy;')).toBe(
      `Salt & pepper <3 "hot" 'n' spicy &copy;`,
    )
  })

  it('collapses runs of blank lines and whitespace', () => {
    expect(htmlToText('a<br><br><br><br>b   c')).toBe('a\n\nb c')
  })

  it('returns null when nothing is left', () => {
    expect(htmlToText('<p> </p>')).toBeNull()
    expect(htmlToText(null)).toBeNull()
  })
})

describe('cents', () => {
  it('rounds to two decimal places', () => {
    expect(cents(1.1 * 3)).toBe(3.3)
    expect(cents(4.2 * 2)).toBe(8.4)
  })
})

describe('httpsUrl', () => {
  it('keeps https URLs only', () => {
    expect(httpsUrl('https://cdn0.woolworths.media/a.jpg')).toBe('https://cdn0.woolworths.media/a.jpg')
    expect(httpsUrl('http://cdn0.woolworths.media/a.jpg')).toBeNull()
    expect(httpsUrl('data:image/png;base64,AAAA')).toBeNull()
    expect(httpsUrl(null)).toBeNull()
  })
})
