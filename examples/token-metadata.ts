import { createPublicClient, http, type Hex, type PublicClient, type TypedDataDefinition } from "viem";
import { testnetDeployment } from "@oxley/sdk";
import { createOxleyLaunchClient, type LaunchIdentity } from "@oxley/sdk/launch";
import { createOxleyMetadataClient, type TokenMetadataFields } from "@oxley/sdk/metadata";

const publicClient = createPublicClient({ transport: http("https://testnet-rpc.elysium.kinetiq.xyz") });
const launches = createOxleyLaunchClient({ deployment: testnetDeployment, publicClient });
// The application's root; https://app.oxley.fun by default. Publishing sends the application's own Origin header, so run it from Node, a bot or an agent.
const details = createOxleyMetadataClient();

/**
 * Publishes a token's description and links. `signTypedData` is the creator account's controller wallet: the SDK holds no key, it builds the typed data and sends the signature.
 * The creator account, coin, handover epoch and controller are read from chain, so the signature does not depend on the service's answer for them.
 */
export async function publishDetails(identity: LaunchIdentity, metadata: TokenMetadataFields, signTypedData: (typedData: TypedDataDefinition) => Promise<Hex>) {
  const launch = await launches.getLaunch(identity);
  if (!launch.launched || !launch.launch || !launch.creatorAccount || !launch.accountController) throw new Error("Launch the token first");
  const prepared = await details.prepareMetadataPublication({
    dealId: launch.dealId, coin: launch.launch.coin, creator: launch.creatorAccount, epoch: launch.handoverCount, controller: launch.accountController, metadata,
  });
  if (prepared.signing.method !== "eth_signTypedData_v4") throw new Error("A creator account signs typed data");
  const signature = await signTypedData(prepared.signing.typedData as unknown as TypedDataDefinition);
  // With the public client the creator account is asked whether it accepts the signature before anything is sent.
  return details.submitMetadataPublication(prepared, signature, { publicClient: publicClient as Pick<PublicClient, "readContract"> });
}

/** Publishes the token's image (PNG, JPEG or WebP, up to 900 KB); the service stores it once, as a 512 x 512 WebP, and answers with its CID. */
export async function publishImage(identity: LaunchIdentity, image: Uint8Array, signTypedData: (typedData: TypedDataDefinition) => Promise<Hex>) {
  const launch = await launches.getLaunch(identity);
  if (!launch.launch || !launch.creatorAccount || !launch.accountController) throw new Error("Launch the token first");
  const prepared = await details.prepareImagePublication({
    dealId: launch.dealId, coin: launch.launch.coin, creator: launch.creatorAccount, epoch: launch.handoverCount, controller: launch.accountController, image,
  });
  if (prepared.signing.method !== "eth_signTypedData_v4") throw new Error("A creator account signs typed data");
  return details.submitImagePublication(prepared, await signTypedData(prepared.signing.typedData as unknown as TypedDataDefinition));
}
