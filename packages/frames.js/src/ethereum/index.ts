import {
  createPublicClient,
  http,
  zeroAddress,
  zeroHash,
  type PublicClient,
  type TypedDataParameter,
  type VerifyTypedDataParameters,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

export type PublicKeyBundle = {
  timestamp: number; // unix timestamp of when the signer was created
  proxy_key_bytes: `0x${string}`; // public key (1)
};

export type SignedPublicKeyBundle = {
  public_key_bundle: PublicKeyBundle;
  wallet_address: `0x${string}`; // wallet address (1)
  signature: `0x${string}`;
};

export type FrameActionBody = {
  url: string; // The URL of the Frame that was clicked. May be different from the URL that the data was posted to.
  unixTimestamp: number; // Unix timestamp in milliseconds
  buttonIndex: number; // The button that was clicked
  inputText?: string; // Input text for the Frame's text input, if present. Undefined if no text input field is present
  state?: string; // State that was passed from the frame, passed back to the frame, serialized to a string. Max 4kB.
  transactionId?: `0x${string}`; // The transaction ID of the transaction that was signed
  address?: `0x${string}`; // The address that was signed
};

export type EthereumFrameRequest = {
  clientProtocol: `eth@${string}`; // The client protocol used by the client to generate the payload
  untrustedData: FrameActionBody & {
    // Signature data
    signature: `0x${string}`; // The signature of the FrameAction
    signedPublicKeyBundle: SignedPublicKeyBundle; // The SignedPublicKeyBundle of the signer
  };
  trustedData: {
    // Unused - '0x'
    messageBytes: `0x${string}`;
  };
};

export const EIP712TypesV1: Record<
  "FrameActionBody" | "PublicKeyBundle",
  readonly TypedDataParameter[]
> = {
  FrameActionBody: [
    { name: "frame_url", type: "string" },
    { name: "button_index", type: "uint32" },
    { name: "unix_timestamp", type: "uint64" },
    { name: "input_text", type: "string" },
    { name: "state", type: "string" },
    { name: "transaction_id", type: "bytes32" },
    { name: "address", type: "address" },
  ] as const satisfies readonly TypedDataParameter[],
  PublicKeyBundle: [
    { name: "timestamp", type: "uint64" },
    { name: "proxy_key_bytes", type: "address" },
  ] as const satisfies readonly TypedDataParameter[],
};

export const domain: Record<string, string | number> = {
  name: "Ethereum Frame Action",
  version: "1",
} as const;

export async function verifyPublicKeyBundle(
  signedPublicKeyBundle: SignedPublicKeyBundle
): Promise<boolean> {
  const typedData: VerifyTypedDataParameters = {
    primaryType: "PublicKeyBundle",
    domain,
    types: EIP712TypesV1,
    message: {
      timestamp: signedPublicKeyBundle.public_key_bundle.timestamp,
      wallet_address: signedPublicKeyBundle.wallet_address,
      proxy_key_bytes: signedPublicKeyBundle.public_key_bundle.proxy_key_bytes,
    },
    address: signedPublicKeyBundle.wallet_address,
    signature: signedPublicKeyBundle.signature,
  };

  const publicClient = createPublicClient({
    transport: http(),
    chain: mainnet,
  });

  return publicClient.verifyTypedData(typedData);
}

export function isEthereumFrameActionPayload(
  body: unknown
): body is EthereumFrameRequest {
  if (typeof body !== "object" || body === null) {
    return false;
  }

  if (
    !("clientProtocol" in body) ||
    !("untrustedData" in body) ||
    !("trustedData" in body)
  ) {
    return false;
  }

  const { clientProtocol, untrustedData, trustedData } = body;

  if (clientProtocol !== "eth@v1") {
    return false;
  }

  return (
    typeof clientProtocol === "string" &&
    typeof untrustedData === "object" &&
    untrustedData !== null &&
    typeof trustedData === "object" &&
    trustedData !== null
  );
}

export async function getEthereumFrameMessage(
  body: EthereumFrameRequest,
  publicClient?: PublicClient
): Promise<
  FrameActionBody & { isValid: boolean; requesterWalletAddress: `0x${string}` }
> {
  const { untrustedData } = body;
  const { url, buttonIndex, unixTimestamp, inputText, state } = untrustedData;

  // Validate the signature
  const typedData: VerifyTypedDataParameters = {
    primaryType: "FrameActionBody",
    domain,
    types: EIP712TypesV1,
    message: {
      frame_url: url,
      button_index: buttonIndex,
      unix_timestamp: unixTimestamp,
      input_text: inputText ?? "",
      state: state ?? "",
      // Zero hash and zero address to be treated as undefined
      transaction_id: untrustedData.transactionId ?? zeroHash,
      address: untrustedData.address ?? zeroAddress,
    },
    address:
      untrustedData.signedPublicKeyBundle.public_key_bundle.proxy_key_bytes,
    signature: untrustedData.signature,
  };

  const _publicClient =
    publicClient ??
    createPublicClient({
      transport: http(),
      chain: mainnet,
    });

  const isFrameDataValid = await _publicClient.verifyTypedData(typedData);
  const isSignerValid = await verifyPublicKeyBundle(
    body.untrustedData.signedPublicKeyBundle
  );

  const isValid = isFrameDataValid && isSignerValid;

  return {
    ...untrustedData,
    transactionId:
      untrustedData.transactionId === zeroHash
        ? undefined
        : untrustedData.transactionId,
    address:
      untrustedData.address === zeroAddress ? undefined : untrustedData.address,
    isValid,
    requesterWalletAddress: untrustedData.signedPublicKeyBundle.wallet_address,
  };
}

export async function signPublicKeyBundle(
  publicKeyBundle: PublicKeyBundle,
  walletClient: WalletClient
): Promise<SignedPublicKeyBundle> {
  if (!walletClient.account) {
    throw new Error("Wallet client does not have an account");
  }

  // @ts-expect-error -- This is valid
  const signature = await walletClient.signTypedData({
    primaryType: "PublicKeyBundle",
    domain,
    types: EIP712TypesV1,
    message: {
      timestamp: publicKeyBundle.timestamp,
      proxy_key_bytes: publicKeyBundle.proxy_key_bytes,
    },
  });

  const signedPublicKeyBundle: SignedPublicKeyBundle = {
    public_key_bundle: publicKeyBundle,
    wallet_address: walletClient.account.address,
    signature,
  };

  return signedPublicKeyBundle;
}

export async function createSignedPublicKeyBundle(
  walletClient: WalletClient
): Promise<{
  /** Signed public key bundle as per Ethereum Frames spec */
  signedPublicKeyBundle: SignedPublicKeyBundle;
  /** Private key to be used to sign frame messages */
  privateKey: `0x${string}`;
}> {
  if (!walletClient.account) {
    throw new Error("Wallet client does not have an account");
  }

  const privateKey = generatePrivateKey();
  const signerAccount = privateKeyToAccount(privateKey);

  const publicKeyBundle: PublicKeyBundle = {
    timestamp: Date.now(),
    proxy_key_bytes: signerAccount.address,
  };

  const signedPublicKeyBundle = await signPublicKeyBundle(
    publicKeyBundle,
    walletClient
  );

  return { signedPublicKeyBundle, privateKey };
}

export async function signFrameActionBody(
  body: FrameActionBody,
  proxyWalletClient: WalletClient
): Promise<`0x${string}`> {
  if (!proxyWalletClient.account) {
    throw new Error("Wallet client does not have an account");
  }

  // @ts-expect-error -- This is valid
  const signature = await proxyWalletClient.signTypedData({
    primaryType: "FrameActionBody",
    domain,
    types: EIP712TypesV1,
    message: {
      frame_url: body.url,
      button_index: body.buttonIndex,
      unix_timestamp: BigInt(body.unixTimestamp),
      input_text: body.inputText ?? "",
      state: body.state ?? "",
      transaction_id: body.transactionId ?? zeroHash,
      address: body.address ?? zeroAddress,
    },
  });

  return signature;
}

export async function createEthereumFrameRequest(
  body: FrameActionBody,
  proxyWalletClient: WalletClient,
  signedPublicKeyBundle: SignedPublicKeyBundle
): Promise<EthereumFrameRequest> {
  const signature = await signFrameActionBody(body, proxyWalletClient);

  return {
    clientProtocol: `eth@v1`,
    untrustedData: {
      ...body,
      signature,
      signedPublicKeyBundle,
    },
    trustedData: {
      messageBytes: "0x",
    },
  };
}
