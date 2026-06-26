import { Type } from '@fastify/type-provider-typebox';

// Reusable primitives. All object bodies set additionalProperties:false so
// unknown fields are rejected (SPEC §7.4).
const obj = <T extends Parameters<typeof Type.Object>[0]>(props: T) =>
  Type.Object(props, { additionalProperties: false });

// NOTE: nullable fields are written `Type.Union([Type.Null(), X])` with Null
// FIRST so ajv's coerceTypes matches an incoming null directly instead of
// coercing it (e.g. null -> 0 for a number, silently corrupting a "clear this
// field" request). Keep Null first when adding new nullable fields.

// Entity-ID / foreign-key integers: positive and bounded to the SQLite signed
// 32-bit range so out-of-range / precision-losing values are rejected at the edge.
const Id = Type.Integer({ minimum: 1, maximum: 2147483647 });
const Name = Type.String({ minLength: 1, maxLength: 200 });
const OptText = Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 5000 })]));
const OptPhoto = Type.Optional(Type.Union([Type.Null(), Id]));
const OptPrice = Type.Optional(Type.Union([Type.Null(), Type.Number({ minimum: 0, maximum: 1e12 })]));
const EntityTypeT = Type.Union([Type.Literal('item'), Type.Literal('place')]);
const MethodT = Type.Union([Type.Literal('scan'), Type.Literal('manual')]);
const TagKindT = Type.Union([Type.Literal('event'), Type.Literal('flag'), Type.Literal('other')]);
const CodeValue = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9\\-]+$' });
const Username = Type.String({ minLength: 1, maxLength: 100 });
const NewPassword = Type.String({ minLength: 8, maxLength: 1000 });
const IdParam = obj({ id: Id });

export const S = {
  // ---- auth & users ----
  login: {
    body: obj({
      username: Username,
      password: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
  },
  setup: { body: obj({ username: Username, password: NewPassword }) },
  createUser: { body: obj({ username: Username, password: NewPassword }) },
  changePassword: { params: IdParam, body: obj({ password: NewPassword }) },
  userId: { params: IdParam },

  // ---- items ----
  itemsQuery: {
    querystring: obj({
      tag: Type.Optional(Id),
      place: Type.Optional(Id),
      status: Type.Optional(Type.Union([Type.Literal('in'), Type.Literal('out')])),
      q: Type.Optional(Type.String({ maxLength: 200 })),
      archived: Type.Optional(Type.Boolean()),
    }),
  },
  createItem: {
    body: obj({
      name: Name,
      notes: OptText,
      photo_id: OptPhoto,
      price: OptPrice,
      location_place_id: Type.Optional(Type.Union([Type.Null(), Id])),
      code_value: Type.Optional(CodeValue),
      method: Type.Optional(MethodT),
    }),
  },
  patchItem: {
    params: IdParam,
    body: obj({ name: Type.Optional(Name), notes: OptText, photo_id: OptPhoto, price: OptPrice }),
  },
  moveItem: {
    params: IdParam,
    body: obj({
      to_place_id: Type.Union([Type.Null(), Id]),
      method: Type.Optional(MethodT),
      note: OptText,
    }),
  },
  bulkMoveItems: {
    body: obj({
      item_ids: Type.Array(Id, { minItems: 1, maxItems: 500 }),
      to_place_id: Type.Union([Type.Null(), Id]),
      method: Type.Optional(MethodT),
      note: OptText,
    }),
  },
  itemTag: { params: IdParam, body: obj({ tag_id: Id }) },
  itemTagDelete: { params: obj({ id: Id, tagId: Id }) },
  byId: { params: IdParam },

  // ---- places ----
  placesQuery: {
    querystring: obj({
      parent: Type.Optional(Id),
      root: Type.Optional(Type.Boolean()),
      tag: Type.Optional(Id),
      archived: Type.Optional(Type.Boolean()),
    }),
  },
  createPlace: {
    body: obj({
      name: Name,
      parent_place_id: Type.Optional(Type.Union([Type.Null(), Id])),
      info: OptText,
      photo_id: OptPhoto,
      code_value: Type.Optional(CodeValue),
      method: Type.Optional(MethodT),
    }),
  },
  patchPlace: {
    params: IdParam,
    body: obj({ name: Type.Optional(Name), info: OptText, photo_id: OptPhoto }),
  },
  movePlace: {
    params: IdParam,
    body: obj({
      parent_place_id: Type.Union([Type.Null(), Id]),
      method: Type.Optional(MethodT),
      note: OptText,
    }),
  },

  // ---- codes ----
  resolve: { params: obj({ code: CodeValue }) },
  printCodes: {
    body: obj({
      type: EntityTypeT,
      count: Type.Integer({ minimum: 1, maximum: 200 }),
    }),
  },
  assignCode: {
    body: obj({ code_value: CodeValue, entity_type: EntityTypeT, entity_id: Id }),
  },

  // ---- tags ----
  createTag: {
    body: obj({
      name: Type.String({ minLength: 1, maxLength: 100 }),
      color: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 32 })])),
      kind: Type.Optional(TagKindT),
    }),
  },

  // ---- movements ----
  movementsQuery: {
    querystring: obj({
      entity_type: Type.Optional(EntityTypeT),
      entity_id: Type.Optional(Id),
      from: Type.Optional(Type.String({ maxLength: 40 })),
      to: Type.Optional(Type.String({ maxLength: 40 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
  },

  media: { params: obj({ id: Id }) },
};
