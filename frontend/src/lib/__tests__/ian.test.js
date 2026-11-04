import { describe, expect, it } from 'vitest'
import { CHANGE_PLAN, changeLabel } from '../startChoice.js'

describe('checking the change plan helper', () => {
    it('ensures the button is named correctly', () => {
        expect(changeLabel('known')).toBe('Choose the area')
        expect(changeLabel('fairest')).toBe('Work out the spots again')
    })

    it('names the stops only for a confirmed plan', () => {
        const voting = CHANGE_PLAN.lost(false)
        const confirmed = CHANGE_PLAN.lost(true)
        expect(voting).toHaveLength(3)
        expect(voting).not.toContain("the itinerary's stops and any proposed places")

        expect(confirmed).toHaveLength(4)
        expect(confirmed).toContain("the itinerary's stops and any proposed places")
    })
})