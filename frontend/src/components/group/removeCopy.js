// The words of the question the host is asked before taking someone out of a shared session, written once so the button beside a
// name (RemoveMember) and the button under "Waiting for" (GroupDetailView) say the same thing. Taking someone out is for good:
// their row goes. They can come back only with an invite link that still works; an invitation to a username is used up when it is
// accepted, so a person who came in that way cannot.

// How to call: removeTitle('Kim') -> 'Remove Kim?'
export const removeTitle = (name) => `Remove ${name || 'this person'}?`

// How to call: removeText('Kim') -> 'Kim is removed from this session and it disappears from their list. ...'
export const removeText = (name) =>
  `${name || 'This person'} is removed from this session and it disappears from their list. If they joined with an invite link that still works, they can rejoin with it. Someone invited by username cannot.`
