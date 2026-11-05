// Sample café vouchers that can be redeemed with JioCoins. Each successful meetup earns 100 JioCoins.
// The café names are invented on purpose: no real business has agreed to any of these offers.
// category: one of REWARD_CATEGORIES, for the filter on the Rewards screen.

// The voucher categories, in the order the filter shows them, with the icon each voucher card shows.
export const REWARD_CATEGORIES = [
  { id: 'coffee', label: 'Coffee', icon: 'drink' },
  { id: 'dessert', label: 'Desserts', icon: 'sparkle' },
  { id: 'bakery', label: 'Bakery', icon: 'eat' },
  { id: 'tea', label: 'Tea', icon: 'drink' },
  { id: 'meal', label: 'Meals', icon: 'eat' },
]

export const REWARDS = [
  { id: 'r-nylon', category: 'coffee', cafe: 'Kopi Corner (sample)', offer: 'SGD 3 off any coffee', cost: 60 },
  { id: 'r-plain-vanilla', category: 'dessert', cafe: 'Sample Cupcake Shop', offer: 'One free cupcake', cost: 80 },
  { id: 'r-tbb', category: 'bakery', cafe: 'Sample Bakery', offer: 'SGD 5 off', cost: 100 },
  { id: 'r-creamier', category: 'dessert', cafe: 'Sample Ice Cream Stand', offer: 'One free scoop', cost: 120 },
  { id: 'r-forty-hands', category: 'coffee', cafe: 'Sample Coffee Bar', offer: 'One free coffee', cost: 150 },
  { id: 'r-chye-seng-huat', category: 'bakery', cafe: 'Sample Roastery', offer: 'Free pastry with any drink', cost: 180 },
  { id: 'r-merci-marcel', category: 'tea', cafe: 'Sample Tea House', offer: 'Two drinks for the price of one', cost: 220 },
  { id: 'r-lolas', category: 'meal', cafe: 'Sample Corner Café', offer: 'SGD 10 off', cost: 300 },
  // Bigger prizes that take a while to save for, so "Can claim" has something to leave out (Faith, 31 October 2026).
  { id: 'r-tea-for-two', category: 'tea', cafe: 'Sample Tea Room', offer: 'Afternoon tea for two', cost: 1500 },
  { id: 'r-brunch', category: 'meal', cafe: 'Sample Brunch Bar', offer: 'Brunch for two', cost: 2000 },
  { id: 'r-whole-cake', category: 'dessert', cafe: 'Sample Patisserie', offer: 'A whole cake', cost: 2500 },
]
