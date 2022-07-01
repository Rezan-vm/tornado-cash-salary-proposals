import Axios from "axios";
import { ethers } from "ethers";
import fs from "fs";

// Add delegate, check for current delegate at https://safe-transaction.mainnet.gnosis.io/api/v1/safes/0xb04E030140b30C27bcdfaafFFA98C57d80eDa7B4/delegates/
// https://github.com/safe-global/safe-docs/blob/devportal/docs/tutorial_tx_service_set_delegate.md#add-new-delegate

const GNOSIS_SAFE_TRANSACTION_API = "https://safe-transaction.mainnet.gnosis.io";
const TCASH_COMMUNITY_SAFE_ADDRESS = "0xb04E030140b30C27bcdfaafFFA98C57d80eDa7B4";
const SAFE_MULTI_SEND = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";
const TORN_ADDRESS = "0x77777FeDdddFfC19Ff86DB637967013e6C6A116C";
const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";

const main = async () => {
  if (!process.env.SAFE_DELEGATE_PRIVATE_KEY) {
    throw Error("SAFE_DELEGATE_PRIVATE_KEY undefined");
  }

  if (!process.env.ETH_RPC) {
    throw Error("ETH_RPC undefined");
  }

  const gnosisRelayApi = GNOSIS_SAFE_TRANSACTION_API.replace("safe-transaction", "safe-relay");
  const safeDelegatePk = process.env.SAFE_DELEGATE_PRIVATE_KEY;

  const provider = new ethers.providers.StaticJsonRpcProvider(process.env.ETH_RPC);

  const safeContract = new ethers.Contract(
    TCASH_COMMUNITY_SAFE_ADDRESS,
    [
      "function nonce() view returns (uint256)",
      "function getTransactionHash(address to, uint256 value, bytes memory data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view external returns (bytes32)",
    ],
    provider
  );

  let nonce: number;

  const safeApiTxs = (
    await Axios.get(
      `${GNOSIS_SAFE_TRANSACTION_API}/api/v1/safes/${TCASH_COMMUNITY_SAFE_ADDRESS}/multisig-transactions`
    )
  ).data.results;
  const onChainNonce = (await safeContract.nonce()).toNumber();
  const pendingNonce =
    safeApiTxs.length > 1
      ? (safeApiTxs.sort((a: any, b: any) => b.nonce - a.nonce)[0].nonce as number)
      : null;

  if (!pendingNonce) {
    nonce = onChainNonce;
  } else if (onChainNonce > pendingNonce) {
    nonce = onChainNonce;
  } else {
    nonce = pendingNonce + 1;
  }

  const salariesCsv = fs
    .readFileSync("contributors-salaries.csv", "utf-8")
    .split("\n")
    .map((l) => l.split(","));

  const erc20Iface = new ethers.utils.Interface(["function transfer(address recipient, uint256 amount)"]);

  let tornPrice = (await getCoinGeckoPrice(["tornado-cash"]))[0];

  let salariesCalldata = salariesCsv
    .slice(1)
    .map((l) =>
      erc20Iface.encodeFunctionData("transfer", [
        l[2],
        ((Number(l[3]) / tornPrice) * 1e18).toLocaleString("fullwide", { useGrouping: false }),
      ])
    );

  salariesCalldata = salariesCalldata.map((calldata) =>
    ethers.utils.solidityPack(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      ["0", TORN_ADDRESS, "0", ethers.utils.hexDataLength(calldata), calldata]
    )
  );

  const multisendIface = new ethers.utils.Interface([
    "function multiSend(bytes memory transactions) public payable",
  ]);

  const proposalData = {
    to: SAFE_MULTI_SEND,
    data: multisendIface.encodeFunctionData("multiSend", [ethers.utils.hexConcat(salariesCalldata)]),
  };

  console.log(proposalData);
  let safeTxGas: number;
  try {
    const resp = await Axios.post(
      `${gnosisRelayApi}/api/v2/safes/${TCASH_COMMUNITY_SAFE_ADDRESS}/transactions/estimate/`,
      {
        to: proposalData.to,
        value: 0,
        data: proposalData.data,
        operation: 1,
        gasToken: null,
      }
    );
    safeTxGas = parseInt(resp.data.safeTxGas);
  } catch (err: any) {
    if (err.response) {
      console.log(err.response.status);
      console.log(err.response.data);
    } else {
      console.log(err);
    }
    console.log("Relay service not working, use 2m gas");
    safeTxGas = 2e6;
  }

  const txHash = await safeContract.getTransactionHash(
    proposalData.to,
    0,
    proposalData.data,
    1, // Delegatecall
    safeTxGas,
    0,
    0,
    NULL_ADDRESS,
    NULL_ADDRESS,
    nonce
  );

  const wallet = new ethers.Wallet(safeDelegatePk);
  const signer = new ethers.utils.SigningKey(safeDelegatePk);

  const payload = {
    to: proposalData.to,
    value: 0,
    data: proposalData.data,
    operation: 1, // Delegatecall 
    gasToken: null,
    safeTxGas: safeTxGas,
    baseGas: 0,
    gasPrice: 0,
    refundReceiver: null,
    nonce: nonce,
    contractTransactionHash: txHash,
    sender: wallet.address,
    signature: ethers.utils.joinSignature(signer.signDigest(txHash)),
    origin: "CI proposal transaction",
  };

  try {
    await Axios.post(
      `${GNOSIS_SAFE_TRANSACTION_API}/api/v1/safes/${TCASH_COMMUNITY_SAFE_ADDRESS}/multisig-transactions/`,
      payload
    );
    console.log("Transaction posted to safe");
  } catch (err: any) {
    console.error(`Error safe post transaction: ${err.response ? err.response.statusText : err}`);
    console.log(err.response ? err.response.data : null);
    process.exit(1);
  }
};

export const getCoinGeckoPrice = async (geckoIds: string[]): Promise<number[]> => {
  const res = await Axios.get(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${geckoIds.join(",")}`
  );

  // The order of the gecko prices aren't in order, we need to look for the ids
  // [
  //   {
  //     id: 'oxygen',
  //     symbol: 'oxy',
  //     name: 'Oxygen',
  //     image: 'https://assets.coingecko.com/coins/images/13509/large/8DjBZ79V_400x400.jpg?1609236331',
  //     current_price: 0.384841,
  //     market_cap: 77865935,
  //     market_cap_rank: 470,
  //     fully_diluted_valuation: 3847863695,
  //     total_volume: 734347,
  //     high_24h: 0.401638,
  //     low_24h: 0.356784,
  //     price_change_24h: 0.02604655,
  //     price_change_percentage_24h: 7.25947,
  //     market_cap_change_24h: 5402552,
  //     market_cap_change_percentage_24h: 7.45556,
  //     circulating_supply: 202361469.02,
  //     total_supply: 10000000000,
  //     max_supply: 10000000000,
  //     ath: 4.16,
  //     ath_change_percentage: -90.74782,
  //     ath_date: '2021-03-16T22:38:50.717Z',
  //     atl: 0.214085,
  //     atl_change_percentage: 79.64977,
  //     atl_date: '2022-01-24T11:09:29.240Z',
  //     roi: null,
  //     last_updated: '2022-03-01T18:28:54.358Z'
  //   },
  // ]

  const ret: number[] = [];
  for (let i = 0; i < geckoIds.length; i++) {
    const item = res.data.find((x: any) => x.id === geckoIds[i]);
    ret.push(item.current_price);
  }

  return ret;
};

main();
