// A select's error is tied to the select, as a text field's is (components/ui/SelectField.vue): the select points at the
// message with aria-describedby, so a screen reader reads the error with the field. Drawn with the stand-in page (domless.js).
import { describe, expect, it } from 'vitest'
import { mountScreen } from './domless.js'
import SelectField from '../../components/ui/SelectField.vue'

const field = (props) => mountScreen(SelectField, { props: { label: 'Area', options: ['Bugis', 'Orchard'], modelValue: '', ...props } })

describe('SelectField', () => {
  it('ties its error to the select, as TextField does', async () => {
    const view = await field({ error: 'Choose an area' })
    const select = view.one('select')
    const error = view.all('p').find((p) => view.text(p) === 'Choose an area')
    expect(error.attrs.id).toBeTruthy()
    expect(select.attrs['aria-describedby']).toBe(error.attrs.id)
    expect(select.attrs['aria-invalid']).toBe('true')
    expect(error.attrs.role).toBe('alert')
  })

  it('describes nothing when there is no error', async () => {
    const view = await field()
    const select = view.one('select')
    expect(select.attrs['aria-describedby']).toBeUndefined()
    expect(select.attrs['aria-invalid']).toBeUndefined()
  })

  it('uses the id it is given for the error too', async () => {
    const view = await field({ error: 'Choose an area', id: 'area' })
    expect(view.one('select').attrs['aria-describedby']).toBe('area-help')
    expect(view.one('select').attrs.id).toBe('area')
  })
})
