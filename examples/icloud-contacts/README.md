# iCloud Contacts (example)

An example of an `http` adapter speaking CardDAV to iCloud, read only, with the same kept credential
as the calendar example. `find_contacts` discovers the address book and asks the server for the cards
whose name contains the words given (an `addressbook-query` REPORT), then reads each vCard
(`src/vcard.ts`: unfolding, grouped properties such as `item1.EMAIL`, escaped text).

An account on another server than `p01-contacts.icloud.com` fails as `host-not-allowed` before
anything is sent there; see the calendar example's README for adding it.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "icloud-contacts"`).
