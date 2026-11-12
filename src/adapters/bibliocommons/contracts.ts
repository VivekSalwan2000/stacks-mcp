/**
 * The site contract: exactly the parts of BiblioCommons' page data that Stacks
 * depends on. Nothing else is read.
 *
 * If BiblioCommons renames or removes one of these fields, validation fails
 * and the tool throws SITE_CHANGED naming the field. That is the "breaks
 * loudly" guarantee. Keep these schemas as small as the tools allow: every
 * required field here is a way for the site to break us.
 */
import { z } from "zod";

const str = z.string();
const optStr = z.string().nullish();
const optNum = z.number().nullish();
const optBool = z.boolean().nullish();

export const RawApp = z.object({
  baseURL: optStr,
  libraryDomain: optStr,
  coreVersion: optStr,
});

export const RawLibrary = z.object({
  siteId: optStr,
  longName: optStr,
  shortName: optStr,
  homeLink: optStr,
  timezone: optStr,
});

export const RawAvailability = z.object({
  status: str,
  statusType: optStr,
  bibType: optStr,
  totalCopies: optNum,
  availableCopies: optNum,
  heldCopies: optNum,
  onOrderCopies: optNum,
  libraryUseOnly: optBool,
});
export type RawAvailability = z.infer<typeof RawAvailability>;

export const RawBib = z.object({
  id: str,
  briefInfo: z.object({
    title: str,
    subtitle: optStr,
    authors: z.array(str).nullish(),
    format: str,
    publicationDate: optStr,
    callNumber: optStr,
    primaryLanguage: optStr,
    isbns: z.array(str).nullish(),
    audiences: z.array(str).nullish(),
    genreForm: z.array(str).nullish(),
    series: z.array(z.object({ name: optStr })).nullish(),
    rating: z.object({ averageRating: optNum, totalCount: optNum }).nullish(),
  }),
  availability: RawAvailability.nullish(),
});
export type RawBib = z.infer<typeof RawBib>;

export const RawSearchState = z.object({
  app: RawApp,
  search: z.object({
    catalogSearch: z.object({
      results: z.array(z.object({ representative: str, manifestations: z.array(str).nullish() })),
      pagination: z.object({ count: z.number(), page: z.number(), pages: z.number() }),
      didYouMeanQuerySuggestion: optStr,
    }),
  }),
  entities: z.object({
    bibs: z.record(str, RawBib).nullish(),
    libraries: z.record(str, RawLibrary).nullish(),
  }),
});

const RawFieldValue = z.object({ primary: z.object({ values: z.array(str).nullish() }).nullish() });

export const RawCatalogBib = z.object({
  id: str,
  brief: z.object({
    title: str,
    subTitle: optStr,
    format: str,
    publicationDate: optStr,
    description: optStr,
    primaryLanguage: optStr,
    creators: z.array(z.object({ fullName: str, relationships: z.array(str).nullish() })).nullish(),
  }),
  fields: z
    .array(
      z.object({
        category: optStr,
        items: z.array(z.object({ fieldName: str, fieldValues: z.array(RawFieldValue).nullish() })).nullish(),
      }),
    )
    .nullish(),
});

export const RawRecordState = z.object({
  app: RawApp,
  entities: z.object({
    catalogBibs: z.record(str, RawCatalogBib).nullish(),
    bibs: z.record(str, RawBib).nullish(),
    libraries: z.record(str, RawLibrary).nullish(),
  }),
});

export const RawBibItem = z.object({
  collection: optStr,
  callNumber: optStr,
  dueDate: optStr,
  branch: z.object({ name: str, code: str }),
  availability: z.object({
    status: str,
    statusType: optStr,
    libraryStatus: optStr,
    libraryUseOnly: optBool,
  }),
});
export type RawBibItem = z.infer<typeof RawBibItem>;

/** The background response the title page requests for item-level availability. */
export const RawAvailabilityResponse = z.object({
  entities: z.object({
    availabilities: z.record(str, RawAvailability).nullish(),
    bibItems: z.record(str, RawBibItem).nullish(),
  }),
});

const RawNamed = z.object({ id: str, name: str });

export const RawLocation = z.object({
  id: str,
  name: str,
  isHidden: optBool,
  address: z
    .object({ number: optStr, street: optStr, city: optStr, state: optStr, zip: optStr, country: optStr })
    .nullish(),
  hours: z.array(z.object({ timeRef: str, openTime: optStr, closeTime: optStr })).nullish(),
  mapLocation: z
    .object({ timeZone: optStr, centrePoint: z.object({ lat: z.number(), lng: z.number() }).nullish() })
    .nullish(),
  branchContacts: z.array(z.object({ contactType: optStr, value: optStr })).nullish(),
  facilities: z.array(z.object({ typeId: str })).nullish(),
  specialHoursIds: z.array(str).nullish(),
  highlights: z.array(z.object({ label: optStr })).nullish(),
  directions: optStr,
  directionsAndParking: optStr,
  accessibilityInfo: optStr,
  webUrl: optStr,
});
export type RawLocation = z.infer<typeof RawLocation>;

export const RawSpecialHours = z.object({
  id: str,
  name: optStr,
  startDate: str,
  endDate: str,
  openTime: optStr,
  closeTime: optStr,
  allLocations: optBool,
  locationIds: z.array(str).nullish(),
});

export const RawLocationsState = z.object({
  app: RawApp,
  locations: z.object({ locationsSearch: z.object({ results: z.array(str) }) }),
  entities: z.object({
    locations: z.record(str, RawLocation),
    facilityTypes: z.record(str, z.object({ id: str, label: str, isHidden: optBool })).nullish(),
    specialHours: z.record(str, RawSpecialHours).nullish(),
    libraries: z.record(str, RawLibrary).nullish(),
  }),
});

export const RawEvent = z.object({
  id: str,
  isRecurring: optBool,
  isFull: optBool,
  registrationClosed: optBool,
  definition: z.object({
    title: str,
    start: str,
    end: optStr,
    description: optStr,
    branchLocationId: optStr,
    locationDetails: optStr,
    audienceIds: z.array(str).nullish(),
    typeIds: z.array(str).nullish(),
    languageIds: z.array(str).nullish(),
    isCancelled: optBool,
    registrationInfo: z.object({ enabledMethods: z.array(z.unknown()).nullish() }).nullish(),
  }),
});
export type RawEvent = z.infer<typeof RawEvent>;

export const RawEventsState = z.object({
  app: RawApp,
  events: z.object({
    eventsSearch: z.object({
      results: z.array(str),
      pagination: z.object({ count: z.number(), page: z.number(), pages: z.number() }),
    }),
  }),
  entities: z.object({
    events: z.record(str, RawEvent).nullish(),
    locations: z.record(str, z.object({ id: str, name: str })).nullish(),
    eventAudiences: z.record(str, RawNamed).nullish(),
    eventTypes: z.record(str, RawNamed).nullish(),
    eventLanguages: z.record(str, RawNamed).nullish(),
    libraries: z.record(str, RawLibrary).nullish(),
  }),
});
